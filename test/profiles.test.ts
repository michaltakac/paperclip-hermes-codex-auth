import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeProfileName, listProfiles, readProfile } from "../src/hermes/profiles.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hermes-profiles-"));
  await mkdir(join(root, "never-signed-in"));
  await mkdir(join(root, "signed-in"));
  await mkdir(join(root, "broken"));
  await mkdir(join(root, ".hidden"));
  await writeFile(
    join(root, "signed-in", "auth.json"),
    JSON.stringify({
      version: 1,
      providers: {
        "openai-codex": { tokens: { access_token: "x", refresh_token: "y" }, last_refresh: "2026-09-04T12:09:16Z" },
      },
      credential_pool: { "openai-codex": [{ id: "a" }, { id: "b" }] },
    }),
  );
  await writeFile(join(root, "broken", "auth.json"), "{ not json");
  return root;
}

describe("listProfiles", () => {
  it("finds each profile and reports whether it holds a credential", async () => {
    const profiles = await listProfiles(await fixture());
    expect(profiles.map((p) => p.name)).toEqual(["broken", "never-signed-in", "signed-in"]);
    expect(profiles.find((p) => p.name === "signed-in")).toMatchObject({
      hasCredential: true,
      pooled: 2,
      lastRefresh: "2026-09-04T12:09:16Z",
    });
    expect(profiles.find((p) => p.name === "never-signed-in")?.hasCredential).toBe(false);
  });

  it("reports an unreadable auth.json rather than pretending it is signed in", async () => {
    const profiles = await listProfiles(await fixture());
    const broken = profiles.find((p) => p.name === "broken");
    expect(broken?.hasCredential).toBe(false);
    expect(broken?.problem).toMatch(/could not be parsed/);
  });

  it("returns an empty list when Hermes is not installed at all", async () => {
    expect(await listProfiles("/nonexistent/hermes/profiles")).toEqual([]);
  });

  it("treats a missing auth.json as the normal never-signed-in state", async () => {
    const summary = await readProfile(await fixture(), "never-signed-in");
    expect(summary.hasCredential).toBe(false);
    expect(summary.problem).toBeUndefined();
  });
});

describe("isSafeProfileName", () => {
  it("accepts ordinary profile names", () => {
    for (const name of ["default", "team-dev", "profile_1", "a.b-c"]) {
      expect(isSafeProfileName(name)).toBe(true);
    }
  });

  it("rejects anything that could escape the profiles directory", () => {
    // The name becomes a path segment and the child's HERMES_HOME, so traversal
    // here would point the login — and the file it writes — anywhere.
    for (const name of ["..", ".", "../evil", "a/b", "/etc", "", "-leading", "x".repeat(65)]) {
      expect(isSafeProfileName(name)).toBe(false);
    }
  });
});
