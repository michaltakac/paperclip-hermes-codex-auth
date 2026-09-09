import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeMissingHermes, locateHermes } from "../src/hermes/locate.js";

async function fakeHermes(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hermes-bin-"));
  const path = join(dir, "hermes");
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

describe("locateHermes", () => {
  it("uses the configured path when it works — an operator who set it meant it", async () => {
    const path = await fakeHermes();
    expect(await locateHermes(path)).toEqual({ ok: true, path, source: "configured" });
  });

  it("falls back rather than failing when the configured path does not exist", async () => {
    // The exact case that made a signed-in profile report a broken credential:
    // the stock default is wrong for a virtualenv install.
    const found = await fakeHermes();
    const dir = found.slice(0, found.lastIndexOf("/"));
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      const result = await locateHermes("/nonexistent/bin/hermes");
      expect(result).toMatchObject({ ok: true, path: found, source: "path" });
    } finally {
      process.env.PATH = previous;
    }
  });

  it("reports every path it tried, so the failure is actionable", async () => {
    const previous = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await locateHermes("/nonexistent/bin/hermes");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.tried[0]).toBe("/nonexistent/bin/hermes");
        expect(result.tried).toContain("/paperclip/hermes-venv/bin/hermes");
      }
    } finally {
      process.env.PATH = previous;
    }
  });

  it("does not test the same path twice", async () => {
    const previous = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await locateHermes("/usr/local/bin/hermes");
      if (!result.ok) {
        expect(new Set(result.tried).size).toBe(result.tried.length);
      }
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe("describeMissingHermes", () => {
  it("names the paths and the setting that fixes it", () => {
    const message = describeMissingHermes(["/a/hermes", "/b/hermes"]);
    expect(message).toContain("/a/hermes");
    expect(message).toContain("/b/hermes");
    expect(message).toMatch(/settings/i);
    expect(message).toMatch(/virtualenv/i);
  });
});
