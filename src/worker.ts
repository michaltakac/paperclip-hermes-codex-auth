/**
 * Worker for the Hermes Codex sign-in plugin.
 *
 * It owns exactly one thing: the live device-code login for one Hermes profile.
 *
 * Unlike the sibling Claude plugin, no credential ever passes through here.
 * Hermes writes `auth.json` into the profile directory itself, so this worker's
 * job ends at "a credential landed, and it works". There is deliberately no code
 * path that reads an access or refresh token — which is why there is no code
 * path that can leak one.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import manifest, { ACTIONS } from "./manifest.js";
import {
  isSafeProfileName,
  listProfiles,
  readProfile,
  type ProfileSummary,
} from "./hermes/profiles.js";
import { startAuthSession, type AuthSession } from "./hermes/session.js";
import { verifyProfile } from "./hermes/verify.js";
import type { AuthPhase } from "./hermes/parse.js";

interface ResolvedConfig {
  hermesPath: string;
  profilesRoot: string;
  scriptPath: string;
  verify: boolean;
}

const DEFAULTS: ResolvedConfig = {
  hermesPath: "/usr/local/bin/hermes",
  profilesRoot: "/paperclip/.hermes/profiles",
  scriptPath: "/usr/bin/script",
  verify: true,
};

export interface PublicStatus {
  state: "idle" | "starting" | "awaiting_authorization" | "verifying" | "succeeded" | "failed";
  profile?: string;
  url?: string;
  /** The device code, shown so it can be typed into the OpenAI page. */
  userCode?: string;
  reason?: string;
  /**
   * Redacted PTY output.
   *
   * ⚠ UNTRUSTED. Subprocess output, rendered as escaped React text and never as
   * HTML. Do not feed it to a model — not to summarise a failure, not to triage
   * diagnostics. A subprocess able to place text here would otherwise have a
   * direct path into a model's instructions. There is no such sink today; this
   * note exists so that stays true.
   */
  transcript?: string;
}

interface Entry {
  session: AuthSession;
  ownerUserId: string;
  profile: string;
  verifying: boolean;
  final?: PublicStatus;
}

/**
 * One live sign-in per company, owned by whoever started it.
 *
 * Ownership is not decoration: the device code is a live second factor while
 * the flow is open, so an unowned session would let any principal able to reach
 * this company's actions read a code somebody else is mid-way through using.
 */
const sessions = new Map<string, Entry>();

const lastTranscripts = new Map<
  string,
  { transcript: string; at: string; ownerUserId: string; expiresAt: number }
>();

/** Diagnostics are for the run you just did, not an archive. */
const TRANSCRIPT_TTL_MS = 30 * 60 * 1000;

interface ActorContext {
  companyId?: string;
  actor: { type?: string; userId?: string; companyId?: string };
}

/**
 * Resolve the caller from the host, never from the caller's own parameters.
 *
 * Signing in mints a subscription credential, which is a human action. An agent
 * principal is refused outright: an agent that could drive this flow could hand
 * itself an identity nobody chose to give it.
 */
function requireActor(context: ActorContext): { companyId: string; userId: string } {
  const companyId = context.companyId ?? context.actor.companyId;
  if (!companyId) throw new Error("This action must be performed in the context of a company.");
  if (context.actor.type !== "user" || !context.actor.userId) {
    throw new Error("Only a signed-in person can manage the Hermes Codex sign-in.");
  }
  return { companyId, userId: context.actor.userId };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toPublic(phase: AuthPhase, profile: string): PublicStatus {
  switch (phase.kind) {
    case "starting":
      return { state: "starting", profile };
    case "awaiting_authorization":
      return { state: "awaiting_authorization", profile, url: phase.url, userCode: phase.userCode };
    case "succeeded":
      return { state: "succeeded", profile };
    case "failed":
      return { state: "failed", profile, reason: phase.reason };
  }
}

let cachedConfig: ResolvedConfig | null = null;

/**
 * Resolve operator config lazily, inside a request.
 *
 * `ctx.config.get()` needs a company context and throws during `setup()`, which
 * would fail worker initialization outright. Every caller here is already
 * company-scoped, so the read happens on first use and is cached — the values
 * come from `instanceConfigSchema`, so they do not vary per company.
 *
 * A read failure falls back to defaults rather than breaking sign-in: an
 * unconfigured instance should still work on a stock container layout.
 */
async function resolveConfig(ctx: {
  config: { get(): Promise<Record<string, unknown>> };
  logger: { warn(message: string, meta?: unknown): void };
}): Promise<ResolvedConfig> {
  if (cachedConfig) return cachedConfig;

  let raw: Record<string, unknown> = {};
  try {
    raw = await ctx.config.get();
  } catch (error) {
    ctx.logger.warn("Could not read plugin config; using defaults.", { error: String(error) });
  }

  cachedConfig = {
    hermesPath: str(raw.hermesPath) ?? DEFAULTS.hermesPath,
    profilesRoot: str(raw.profilesRoot) ?? DEFAULTS.profilesRoot,
    scriptPath: str(raw.scriptPath) ?? DEFAULTS.scriptPath,
    verify: typeof raw.verify === "boolean" ? raw.verify : DEFAULTS.verify,
  };
  return cachedConfig;
}

export function createHermesCodexAuthPlugin() {
  return definePlugin({
    async setup(ctx) {
      ctx.actions.register(ACTIONS.profiles, async (_input, context) => {
        const { companyId } = requireActor(context as ActorContext);
        const cfg = await resolveConfig(ctx);
        const profiles = await listProfiles(cfg.profilesRoot);
        const active = sessions.get(companyId);
        return {
          profilesRoot: cfg.profilesRoot,
          profiles,
          busyProfile: active && !active.final ? active.profile : undefined,
        };
      });

      ctx.actions.register(ACTIONS.start, async (input, context) => {
        const { companyId, userId } = requireActor(context as ActorContext);
        const cfg = await resolveConfig(ctx);
        const name = str((input as { profile?: unknown } | undefined)?.profile);
        if (!name || !isSafeProfileName(name)) {
          throw new Error("Pick a Hermes profile to sign in.");
        }

        const existing = sessions.get(companyId);
        if (existing && !existing.final) {
          if (existing.ownerUserId !== userId) {
            throw new Error("Another person is signing in on this instance right now.");
          }
          existing.session.cancel();
        }

        const target = (await listProfiles(cfg.profilesRoot)).find((p) => p.name === name);
        if (!target) throw new Error(`No Hermes profile named "${name}" was found.`);

        const session = startAuthSession({
          hermesPath: cfg.hermesPath,
          scriptPath: cfg.scriptPath,
          profilePath: target.path,
          profilesRoot: cfg.profilesRoot,
          profileName: name,
        });
        const entry: Entry = { session, ownerUserId: userId, profile: name, verifying: false };
        sessions.set(companyId, entry);

        void session.done().then(async ({ phase }) => {
          lastTranscripts.set(companyId, {
            transcript: session.transcript(),
            at: new Date().toISOString(),
            ownerUserId: userId,
            expiresAt: Date.now() + TRANSCRIPT_TTL_MS,
          });
          if (phase.kind !== "succeeded") {
            entry.final = toPublic(phase, name);
            return;
          }
          if (!cfg.verify) {
            entry.final = { state: "succeeded", profile: name };
            return;
          }
          // Presence is not validity — see hermes/verify.ts.
          entry.verifying = true;
          const result = await verifyProfile({
            hermesPath: cfg.hermesPath,
            profilePath: target.path,
          });
          entry.verifying = false;
          entry.final = result.ok
            ? { state: "succeeded", profile: name }
            : { state: "failed", profile: name, reason: result.reason };
        });

        return toPublic(session.phase(), name);
      });

      ctx.actions.register(ACTIONS.poll, async (_input, context) => {
        const { companyId, userId } = requireActor(context as ActorContext);
        const entry = sessions.get(companyId);
        if (!entry) return { state: "idle" } satisfies PublicStatus;
        if (entry.ownerUserId !== userId) {
          throw new Error("This sign-in was started by someone else.");
        }
        if (entry.final) return { ...entry.final, transcript: entry.session.transcript() };
        if (entry.verifying) return { state: "verifying", profile: entry.profile } satisfies PublicStatus;
        return {
          ...toPublic(entry.session.phase(), entry.profile),
          transcript: entry.session.transcript(),
        };
      });

      ctx.actions.register(ACTIONS.cancel, async (_input, context) => {
        const { companyId, userId } = requireActor(context as ActorContext);
        const entry = sessions.get(companyId);
        if (entry && entry.ownerUserId === userId) {
          entry.session.cancel();
          sessions.delete(companyId);
        }
        return { state: "idle" } satisfies PublicStatus;
      });

      ctx.actions.register(ACTIONS.verify, async (input, context) => {
        requireActor(context as ActorContext);
        const cfg = await resolveConfig(ctx);
        const name = str((input as { profile?: unknown } | undefined)?.profile);
        if (!name || !isSafeProfileName(name)) throw new Error("Pick a Hermes profile to test.");
        const target: ProfileSummary = await readProfile(cfg.profilesRoot, name);
        if (!target.hasCredential) {
          return { ok: false, reason: "That profile has no stored Codex credential yet." };
        }
        return await verifyProfile({ hermesPath: cfg.hermesPath, profilePath: target.path });
      });

      ctx.actions.register(ACTIONS.diagnostics, async (_input, context) => {
        const { companyId, userId } = requireActor(context as ActorContext);
        const entry = lastTranscripts.get(companyId);
        if (!entry || entry.expiresAt < Date.now() || entry.ownerUserId !== userId) {
          return { transcript: undefined };
        }
        return { transcript: entry.transcript, at: entry.at };
      });

      // Nothing company-scoped may be touched here: worker init has no company
      // context, and anything that needs one fails initialization outright.
      //
      // The version is logged because a rebuilt bundle does NOT reload until the
      // plugin is disabled and re-enabled — "which build is live" has to be
      // answerable from the logs.
      ctx.logger.info(`Hermes Codex sign-in plugin ready (v${manifest.version})`);
    },

    async onShutdown() {
      for (const { session } of sessions.values()) session.cancel();
      sessions.clear();
    },
  });
}

const plugin = createHermesCodexAuthPlugin();

export default plugin;
runWorker(plugin, import.meta.url);
