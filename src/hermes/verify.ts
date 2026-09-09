/**
 * Prove a freshly stored credential actually works.
 *
 * `hermes auth status openai-codex` is not enough, for the same reason
 * `claude auth status` was not enough in the sibling plugin: a status command
 * answers "a credential is present", which is a different question from "a
 * credential works". A file can parse, carry both tokens, and still be refused
 * by the provider — an expired refresh token looks exactly like a live one.
 *
 * So this does one minimal real round trip, once per sign-in.
 */

import { execFile } from "node:child_process";

/** A round trip plus model latency. Generous, because failing open is worse. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 90_000;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Interpret the probe's output.
 *
 * Pure, so it is testable without spending a call. Anything unrecognised fails
 * closed: reporting a credential as good when we could not confirm it is the
 * exact mistake this module exists to prevent.
 */
export function interpretProbe(stdout: string, stderr: string, code: number | null): VerifyResult {
  const combined = `${stdout}\n${stderr}`;
  const lowered = combined.toLowerCase();

  if (/no codex credentials stored|not authenticated|run `?hermes auth/.test(lowered)) {
    return { ok: false, reason: "Hermes still reports no stored Codex credential." };
  }
  if (/401|unauthori[sz]ed|invalid_grant|token (is )?(invalid|expired)/.test(lowered)) {
    return { ok: false, reason: "The provider rejected the new credential." };
  }
  if (/rate.?limit|quota|exhausted/.test(lowered)) {
    // Reaching a rate limit still proves the credential authenticated.
    return { ok: true };
  }
  if (code !== 0) {
    return { ok: false, reason: "The credential test did not complete successfully." };
  }
  if (!stdout.trim()) {
    return { ok: false, reason: "Hermes produced no response when the credential was tested." };
  }
  return { ok: true };
}

export interface VerifyOptions {
  hermesPath: string;
  profilePath: string;
  timeoutMs?: number;
  execFileFn?: typeof execFile;
}

/**
 * Run the probe against one profile.
 *
 * `--yolo` is required, not casual: with no TTY Hermes waits on its own tool
 * approval prompt, times out after 60s and answers "Timeout — denying command".
 * Per Hermes' own SECURITY.md the approval gate is not a security boundary —
 * the sandbox is — and this probe runs one fixed prompt with no tools worth
 * approving.
 */
export async function verifyProfile(options: VerifyOptions): Promise<VerifyResult> {
  const { hermesPath, profilePath, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, execFileFn = execFile } = options;

  return new Promise<VerifyResult>((resolve) => {
    execFileFn(
      hermesPath,
      ["chat", "-Q", "-q", "ping", "--source", "tool", "--yolo"],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...minimalEnv(), HERMES_HOME: profilePath, HOME: profilePath },
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ ok: false, reason: `The Hermes executable was not found at ${hermesPath}.` });
          return;
        }
        if (error && "killed" in error && (error as { killed?: boolean }).killed) {
          resolve({ ok: false, reason: "The credential test timed out." });
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code: number }).code)
          : error
            ? 1
            : 0;
        resolve(interpretProbe(out, err, code));
      },
    );
  });
}

function minimalEnv(): Record<string, string> {
  const keep = ["PATH", "LANG", "LC_ALL", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
