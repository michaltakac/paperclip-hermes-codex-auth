import { describe, expect, it } from "vitest";
import {
  derivePhase,
  redactForLogs,
  stripAnsi,
  DEFAULT_ALLOWED_URL_HOSTS,
} from "../src/hermes/parse.js";

/**
 * The byte-for-byte layout emitted by Hermes 0.18.2 running
 * `hermes auth add openai-codex --type oauth --no-browser` under `script -qec`,
 * with the one-time device code replaced by a synthetic one.
 *
 * Recorded rather than paraphrased: the device-code flow is undocumented, so
 * this fixture is the only written specification of it that exists. The escape
 * sequences, the two-space indent and the CRLF line endings are all load-bearing
 * — they are what the parser has to survive.
 */
const REAL_OUTPUT =
  "To continue, follow these steps:\r\n\r\n" +
  "  1. Open this URL in your browser:\r\n" +
  "     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n" +
  "  2. Enter this code:\r\n" +
  "     \x1b[94mWDJB-MJHT\x1b[0m\r\n\r\n" +
  "Waiting for sign-in... (press Ctrl+C to cancel)\r\n";

describe("derivePhase", () => {
  it("reads the URL and user code from real Hermes output", () => {
    const phase = derivePhase(REAL_OUTPUT);
    expect(phase).toEqual({
      kind: "awaiting_authorization",
      url: "https://auth.openai.com/codex/device",
      userCode: "WDJB-MJHT",
    });
  });

  it("is still starting when nothing has been printed", () => {
    expect(derivePhase("")).toEqual({ kind: "starting" });
    expect(derivePhase("   \r\n")).toEqual({ kind: "starting" });
  });

  it("does not claim success — that is the credential file's job", () => {
    const phase = derivePhase(REAL_OUTPUT + "Authenticated successfully!\r\n");
    expect(phase.kind).not.toBe("succeeded");
  });

  it("refuses a link pointing somewhere unexpected", () => {
    const spoofed = REAL_OUTPUT.replace("auth.openai.com", "auth.openai.com.evil.test");
    const phase = derivePhase(spoofed);
    expect(phase.kind).toBe("failed");
    expect(phase.kind === "failed" && phase.reason).toMatch(/unexpected host/);
  });

  it("accepts an explicitly allowed host override", () => {
    const other = REAL_OUTPUT.replace("auth.openai.com", "auth.example.test");
    const phase = derivePhase(other, { allowedUrlHosts: ["auth.example.test"] });
    expect(phase.kind).toBe("awaiting_authorization");
  });

  it("survives an 80-column hard wrap in the URL", () => {
    const wrapped = REAL_OUTPUT.replace(
      "https://auth.openai.com/codex/device",
      "https://auth.openai.com/codex/\r\ndevice",
    );
    const phase = derivePhase(wrapped);
    expect(phase).toMatchObject({ url: "https://auth.openai.com/codex/device" });
  });

  it("reports a timeout as a failure", () => {
    expect(derivePhase(REAL_OUTPUT + "\r\nTimed out waiting for sign-in\r\n").kind).toBe("failed");
  });

  it("names a missing executable rather than hanging on it", () => {
    const phase = derivePhase("script: /usr/local/bin/hermes: No such file or directory\r\n");
    expect(phase.kind).toBe("failed");
    expect(phase.kind === "failed" && phase.reason).toMatch(/not found/);
  });

  it("recognises a Hermes build without the device-code flags", () => {
    const phase = derivePhase("usage: hermes auth [-h] {add,list}\r\nunrecognized arguments: --no-browser\r\n");
    expect(phase.kind).toBe("failed");
    expect(phase.kind === "failed" && phase.reason).toMatch(/Hermes version/);
  });

  it("allowlists only OpenAI by default", () => {
    expect(DEFAULT_ALLOWED_URL_HOSTS).toContain("auth.openai.com");
  });
});

describe("stripAnsi", () => {
  it("removes the colour codes around the value", () => {
    expect(stripAnsi("\x1b[94mWDJB-MJHT\x1b[0m")).toBe("WDJB-MJHT");
  });
});

describe("redactForLogs", () => {
  it("removes the user code, which is a live second factor while open", () => {
    expect(redactForLogs(REAL_OUTPUT)).not.toContain("WDJB-MJHT");
  });

  it("removes token-shaped values if a future build ever echoes one", () => {
    const withTokens =
      'refresh_token: rt.1.AAAAAAAAAAAAAAAAAAAAAAAA "access_token":"eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiY2RlZmdoaWprbG1ub3A"';
    const redacted = redactForLogs(withTokens);
    expect(redacted).not.toContain("rt.1.AAAA");
    expect(redacted).not.toContain("eyJhbGciOi");
  });

  it("leaves ordinary prose readable, so a failure stays diagnosable", () => {
    expect(redactForLogs("Waiting for sign-in...")).toBe("Waiting for sign-in...");
  });
});
