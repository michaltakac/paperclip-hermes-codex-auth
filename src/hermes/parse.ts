/**
 * Interpret the pseudo-terminal output of `hermes auth add openai-codex`.
 *
 * Everything here is pure, so the interpretation is testable without spending a
 * login. The device-code flow this parses is **undocumented**: the Hermes CLI
 * reference states OAuth is "still browser-based; no device-code alternative",
 * but `--no-browser` on 0.18.2 prints a device URL and a user code and polls.
 * That gap is why the parser fails closed and why the test fixtures record the
 * exact bytes observed, rather than a paraphrase of them.
 */

/** Hosts the device URL may point at. A replaced binary must not be able to
 *  send a signed-in human somewhere of its choosing. */
export const DEFAULT_ALLOWED_URL_HOSTS = ["auth.openai.com"] as const;

export type AuthPhase =
  | { kind: "starting" }
  | { kind: "awaiting_authorization"; url: string; userCode: string }
  | { kind: "succeeded" }
  | { kind: "failed"; reason: string };

/** ANSI CSI/OSC escapes. The URL and the code both arrive colourised. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, "");
}

/**
 * Join hard-wrapped lines before matching.
 *
 * A PTY is 80 columns. The Claude sign-in plugin shipped a truncated credential
 * because it read only the first line of a value that had wrapped, and the
 * failure surfaced two layers later as an invalid token. Nothing here is that
 * dangerous — a wrapped URL simply fails to match — but the same defence is
 * cheap, so it is applied rather than re-learned.
 */
function unwrap(text: string): string {
  return text.replace(/\r/g, "").replace(/\n(?=\S)/g, "");
}

const URL_RE = /https?:\/\/[^\s'"<>]+/;
/** e.g. `WDJB-MJHT`. Codex device codes are two groups, letters and digits. */
const CODE_RE = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;

export interface DerivePhaseOptions {
  allowedUrlHosts?: readonly string[];
}

/**
 * Map accumulated output to a phase.
 *
 * Success is deliberately **not** derived from this text. The credential is
 * written by Hermes into `auth.json`, so the caller observes that file and the
 * process exit code instead of trusting a success banner that upstream is free
 * to reword. This function only recognises failure and the authorization step.
 */
export function derivePhase(raw: string, options: DerivePhaseOptions = {}): AuthPhase {
  const text = unwrap(stripAnsi(raw));
  if (!text.trim()) return { kind: "starting" };

  const lowered = text.toLowerCase();

  // Failures first: a late error after a URL was printed still means failure.
  if (/\btimed?\s*out\b|\btimeout\b/.test(lowered)) {
    return { kind: "failed", reason: "Hermes timed out waiting for the sign-in to be approved." };
  }
  if (/access[_ ]denied|declined|rejected/.test(lowered)) {
    return { kind: "failed", reason: "The sign-in was declined in the browser." };
  }
  if (/command not found|no such file or directory/.test(lowered)) {
    return { kind: "failed", reason: "The Hermes executable was not found at the configured path." };
  }
  if (/usage: hermes auth|unrecognized arguments|invalid choice/.test(lowered)) {
    return {
      kind: "failed",
      reason: "This Hermes build does not accept the device-code flags. Check the Hermes version.",
    };
  }

  const urlMatch = URL_RE.exec(text);
  const codeMatch = CODE_RE.exec(text);
  if (urlMatch && codeMatch) {
    const url = urlMatch[0].replace(/[.,)]+$/, "");
    const allowed = options.allowedUrlHosts ?? DEFAULT_ALLOWED_URL_HOSTS;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { kind: "failed", reason: "Hermes printed a sign-in link that could not be read." };
    }
    if (!allowed.includes(host)) {
      return {
        kind: "failed",
        reason: `Hermes printed a sign-in link pointing at an unexpected host (${host}).`,
      };
    }
    return { kind: "awaiting_authorization", url, userCode: codeMatch[1]! };
  }

  return { kind: "starting" };
}

/**
 * Redact before anything is displayed, logged, or retained.
 *
 * The user code is short-lived but is a live second factor while the flow is
 * open, and a token can appear if a future Hermes build decides to echo one.
 * Redaction happens on the way out of the session, not at the display layer,
 * so a new caller cannot forget it.
 */
export function redactForLogs(raw: string): string {
  return stripAnsi(raw)
    .replace(CODE_RE, "<code redacted>")
    .replace(/\b(rt\.[A-Za-z0-9._-]{16,}|ey[A-Za-z0-9._-]{32,}|sk-[A-Za-z0-9._-]{16,})\b/g, "<redacted>")
    .replace(/(access_token|refresh_token|api[_-]?key)(["'\s:=]+)\S+/gi, "$1$2<redacted>");
}
