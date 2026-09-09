/**
 * Find the Hermes executable.
 *
 * The configured default cannot be right for everyone: Hermes is frequently a
 * Python virtualenv install, so `hermes` lives inside the venv and never lands
 * on `PATH` at all. A wrong default is not merely inconvenient — it surfaces as
 * "The Hermes executable was not found" against a *signed-in* profile, which
 * reads as a broken credential rather than a missing setting.
 *
 * So: try the configured path first, then the layouts we have actually seen,
 * and when everything fails say exactly what was tried.
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Checked in order. The venv layout comes first because it is the common one. */
export const HERMES_CANDIDATES = [
  "/paperclip/hermes-venv/bin/hermes",
  "/usr/local/bin/hermes",
  "/usr/bin/hermes",
  "/opt/hermes/bin/hermes",
] as const;

export type LocateResult =
  | { ok: true; path: string; source: "configured" | "candidate" | "path" }
  | { ok: false; tried: string[] };

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a usable `hermes`.
 *
 * A configured path always wins when it works — an operator who set it meant
 * it. It is only fallen back on when it does not exist, which is precisely the
 * case where guessing beats failing.
 */
export async function locateHermes(configured?: string): Promise<LocateResult> {
  const tried: string[] = [];

  if (configured) {
    tried.push(configured);
    if (await isExecutable(configured)) {
      return { ok: true, path: configured, source: "configured" };
    }
  }

  for (const candidate of HERMES_CANDIDATES) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (await isExecutable(candidate)) {
      return { ok: true, path: candidate, source: "candidate" };
    }
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "hermes");
    if (tried.includes(candidate)) continue;
    if (await isExecutable(candidate)) {
      return { ok: true, path: candidate, source: "path" };
    }
  }

  return { ok: false, tried };
}

/** A failure a reader can act on, rather than a fact they must investigate. */
export function describeMissingHermes(tried: string[]): string {
  return `The Hermes executable was not found. Looked in: ${tried.join(", ")}. Set "Path to the Hermes CLI" in this plugin's settings — a virtualenv install is usually at <venv>/bin/hermes.`;
}
