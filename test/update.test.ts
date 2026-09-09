import { describe, expect, it } from "vitest";
import { isNewer, PACKAGE_NAME } from "../src/ui/update.js";

describe("isNewer", () => {
  it("recognises an ordinary bump", () => {
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
    expect(isNewer("1.1.0", "1.0.9")).toBe(true);
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  it("does not offer an update to the version already installed", () => {
    expect(isNewer("1.0.1", "1.0.1")).toBe(false);
  });

  it("does not offer a downgrade", () => {
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
    // 10 > 9 numerically, but a string compare would say otherwise.
    expect(isNewer("1.0.9", "1.0.10")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    expect(isNewer("1.0.10", "1.0.9")).toBe(true);
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
  });

  it("tolerates a leading v and a prerelease suffix", () => {
    expect(isNewer("v1.0.2", "1.0.1")).toBe(true);
    expect(isNewer("1.0.2-beta.1", "1.0.1")).toBe(true);
  });

  it("treats a missing segment as zero", () => {
    expect(isNewer("1.1", "1.0.9")).toBe(true);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
  });
});

describe("PACKAGE_NAME", () => {
  it("matches what the plugin is published as, since upgrade resolves by it", () => {
    expect(PACKAGE_NAME).toBe("paperclip-hermes-codex-auth");
  });
});
