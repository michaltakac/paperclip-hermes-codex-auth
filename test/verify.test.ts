import { describe, expect, it } from "vitest";
import { interpretProbe } from "../src/hermes/verify.js";

describe("interpretProbe", () => {
  it("accepts a normal answer", () => {
    expect(interpretProbe("pong", "", 0)).toEqual({ ok: true });
  });

  it("rejects the state this plugin exists to fix", () => {
    const result = interpretProbe("", "No Codex credentials stored. Run `hermes auth`.", 1);
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a credential the provider refuses", () => {
    expect(interpretProbe("", "401 Unauthorized", 1).ok).toBe(false);
    expect(interpretProbe("", "invalid_grant", 1).ok).toBe(false);
  });

  it("treats a rate limit as proof the credential authenticated", () => {
    expect(interpretProbe("", "429 rate limit exceeded", 1)).toEqual({ ok: true });
  });

  it("fails closed on silence, which a status check would call success", () => {
    // The whole reason this module exists: presence is not validity.
    expect(interpretProbe("", "", 0).ok).toBe(false);
  });

  it("fails closed on an unrecognised non-zero exit", () => {
    expect(interpretProbe("", "something unexpected", 3).ok).toBe(false);
  });
});
