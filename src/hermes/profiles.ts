/**
 * Discover Hermes profiles and report which of them hold a Codex credential.
 *
 * A profile *is* the unit of authentication here. The Paperclip Hermes adapter
 * sets `HERMES_HOME` to the profile directory, and Hermes stores its OAuth
 * state in `auth.json` at that root — so "sign in this agent" and "sign in this
 * profile" are the same act. That is the whole reason this plugin is per-profile
 * rather than per-instance: an OAuth refresh token rotates, and two runtimes
 * sharing one copy race and invalidate each other.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const PROVIDER = "openai-codex";

export interface ProfileSummary {
  /** Directory name, which is what the adapter's `profile` setting holds. */
  name: string;
  path: string;
  /** `auth.json` exists and parses, and carries a credential for the provider. */
  hasCredential: boolean;
  /** ISO timestamp Hermes last refreshed the credential, when it records one. */
  lastRefresh?: string;
  /** Number of pooled credentials for the provider, when readable. */
  pooled?: number;
  /** Set when `auth.json` exists but could not be understood. */
  problem?: string;
}

/** Shape of the fields we read. Everything else in the file is left alone. */
interface AuthFile {
  providers?: Record<string, { last_refresh?: unknown; tokens?: unknown } | undefined>;
  credential_pool?: Record<string, unknown[] | undefined>;
}

/**
 * Read a profile's credential state.
 *
 * Deliberately reads only presence and metadata. The access and refresh tokens
 * in this file are never loaded into the plugin's memory, never returned to the
 * UI, and never logged — there is no code path here that could leak one,
 * because there is no code path here that reads one.
 */
export async function readProfile(root: string, name: string): Promise<ProfileSummary> {
  const path = join(root, name);
  const authPath = join(path, "auth.json");
  const summary: ProfileSummary = { name, path, hasCredential: false };

  let text: string;
  try {
    text = await readFile(authPath, "utf8");
  } catch {
    return summary; // No auth.json is the normal "never signed in" state.
  }

  let parsed: AuthFile;
  try {
    parsed = JSON.parse(text) as AuthFile;
  } catch {
    return { ...summary, problem: "auth.json exists but could not be parsed." };
  }

  const provider = parsed.providers?.[PROVIDER];
  const pool = parsed.credential_pool?.[PROVIDER];
  summary.hasCredential = Boolean(provider?.tokens) || (Array.isArray(pool) && pool.length > 0);
  if (Array.isArray(pool)) summary.pooled = pool.length;
  if (typeof provider?.last_refresh === "string") summary.lastRefresh = provider.last_refresh;
  return summary;
}

/**
 * List every profile under `<hermesHome>/profiles`.
 *
 * Returns an empty list rather than throwing when the directory is absent: a
 * host with no Hermes installed should render an explanation, not an error
 * boundary.
 */
export async function listProfiles(profilesRoot: string): Promise<ProfileSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(profilesRoot);
  } catch {
    return [];
  }

  const out: ProfileSummary[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    try {
      const info = await stat(join(profilesRoot, name));
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(await readProfile(profilesRoot, name));
  }
  return out;
}

/**
 * Reject anything that is not a plain directory name.
 *
 * The profile name arrives from the UI and becomes a path segment and a child
 * process's `HERMES_HOME`. Without this, `../../` would let a caller point the
 * login — and the file it writes — anywhere the worker can reach.
 */
export function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== "." && name !== "..";
}
