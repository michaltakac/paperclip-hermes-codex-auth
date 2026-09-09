/**
 * Drives one `hermes auth add openai-codex --type oauth --no-browser` login on
 * a pseudo-terminal.
 *
 * Why a PTY: run with pipe stdio, the command emits **zero bytes** and waits —
 * the device-code prompt only renders on a terminal. Rather than take a native
 * `node-pty` dependency (which needs a build toolchain in every host image), we
 * borrow the PTY that util-linux `script` already allocates. That keeps this
 * plugin pure JavaScript and installable from npm wherever Paperclip runs.
 *
 * `script` here is the util-linux flavour (`-q -e -c`), which is what Linux
 * container images ship. The BSD/macOS one takes a different argument order and
 * is not supported.
 *
 * Success is **not** parsed. Hermes writes the credential into `auth.json`
 * itself, so the session observes that file plus the exit code. A success
 * banner is upstream's to reword; a written credential is not.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readProfile, type ProfileSummary } from "./profiles.js";
import { derivePhase, redactForLogs, type AuthPhase } from "./parse.js";

/**
 * The child gets an allowlist, not a copy of the worker's environment.
 *
 * The worker inherits whatever the Paperclip runtime was given — database URLs,
 * provider keys, internal tokens. None of that is a login subprocess's business.
 */
const INHERITED_ENV_KEYS = [
  "PATH",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** Head carries the URL and code; tail carries the outcome. Both are bounded
 *  because a misbehaving executable controls the volume in between. */
const MAX_HEAD_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = 16 * 1024;

/** A human has to reach a browser and approve within this window. */
export const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
/** Nothing at all on the PTY by now means it never reached the prompt. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 60 * 1000;

export interface SessionOptions {
  hermesPath: string;
  scriptPath: string;
  /** The profile directory, used verbatim as the child's `HERMES_HOME`. */
  profilePath: string;
  profilesRoot: string;
  profileName: string;
  allowedUrlHosts?: readonly string[];
  sessionTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Seeded for tests; production leaves it undefined. */
  spawnFn?: typeof spawn;
}

export interface AuthSession {
  phase(): AuthPhase;
  /** Redacted. Safe to display; never safe to feed to a model. */
  transcript(): string;
  /** Resolves once the child exits and the credential has been re-read. */
  done(): Promise<{ phase: AuthPhase; profile: ProfileSummary }>;
  cancel(): void;
}

export function startAuthSession(options: SessionOptions): AuthSession {
  const {
    hermesPath,
    scriptPath,
    profilePath,
    profilesRoot,
    profileName,
    allowedUrlHosts,
    sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    spawnFn = spawn,
  } = options;

  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The whole point: this login writes into *this* profile and no other.
  env.HERMES_HOME = profilePath;
  env.HOME = profilePath;
  // Hermes probes for a browser to auto-open; there is none in a container, and
  // an attempted launch is one more way for the flow to hang before printing.
  env.BROWSER = "";

  const seconds = Math.max(60, Math.floor(sessionTimeoutMs / 1000));
  const inner = [
    shellQuote(hermesPath),
    "auth",
    "add",
    "openai-codex",
    "--type",
    "oauth",
    "--no-browser",
    "--timeout",
    String(seconds),
  ].join(" ");

  let head = "";
  let tail = "";
  let sawOutput = false;
  let settled = false;
  let current: AuthPhase = { kind: "starting" };

  const child: ChildProcess = spawnFn(scriptPath, ["-qec", inner, "/dev/null"], {
    env,
    cwd: profilePath,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const absorb = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text) sawOutput = true;
    if (head.length < MAX_HEAD_BYTES) head += text.slice(0, MAX_HEAD_BYTES - head.length);
    tail = (tail + text).slice(-MAX_TAIL_BYTES);
    if (current.kind === "starting" || current.kind === "awaiting_authorization") {
      const next = derivePhase(head + "\n" + tail, { allowedUrlHosts });
      // Progress is one-way. A late redraw must not walk the user backwards to
      // a spinner after they have already been shown a code to type.
      if (next.kind !== "starting" || current.kind === "starting") current = next;
    }
  };

  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);

  const timers: NodeJS.Timeout[] = [];
  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };

  timers.push(
    setTimeout(() => {
      if (!sawOutput && !settled) {
        current = { kind: "failed", reason: "Hermes produced no output; the sign-in never started." };
        kill();
      }
    }, startupTimeoutMs),
  );
  timers.push(
    setTimeout(() => {
      if (!settled) {
        current = { kind: "failed", reason: "The sign-in was not completed in time." };
        kill();
      }
    }, sessionTimeoutMs),
  );

  function kill(): void {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  const finished = new Promise<{ phase: AuthPhase; profile: ProfileSummary }>((resolve) => {
    const finish = async (code: number | null): Promise<void> => {
      settled = true;
      clearTimers();
      // The credential is the artifact. Read it back rather than believing text.
      const profile = await readProfile(profilesRoot, profileName);
      if (profile.hasCredential && code === 0) {
        current = { kind: "succeeded" };
      } else if (current.kind !== "failed") {
        current = {
          kind: "failed",
          reason:
            profile.hasCredential === false && code === 0
              ? "Hermes exited successfully but stored no credential for openai-codex."
              : "The sign-in did not complete.",
        };
      }
      resolve({ phase: current, profile });
    };
    child.on("close", (code) => void finish(code));
    child.on("error", (error) => {
      current = { kind: "failed", reason: `Could not start the sign-in: ${error.message}` };
      void finish(null);
    });
  });

  return {
    phase: () => current,
    transcript: () => redactForLogs(head === tail ? head : `${head}\n…\n${tail}`),
    done: () => finished,
    cancel: () => {
      if (!settled) current = { kind: "failed", reason: "Cancelled." };
      kill();
    },
  };
}

/** Single-quote for the one string `script -c` hands to a shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
