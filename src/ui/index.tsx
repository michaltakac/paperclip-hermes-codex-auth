/**
 * A sign-in a non-technical person can finish, once per Hermes profile.
 *
 * No terminal, ever. The pseudo-terminal lives in the worker; what reaches this
 * component is a phase, a link to open, and a short code to type.
 *
 * The panel is a *list*, not a single button, and that is the design rather
 * than a decoration. An OAuth refresh token rotates: two runtimes sharing one
 * copy race and invalidate each other. So the unit of sign-in is the profile,
 * and the UI makes that visible instead of implying one login covers everyone.
 *
 * Two rules earned their keep in the sibling Claude plugin and are kept here:
 *
 * 1. **Progress is one-way.** A late PTY redraw must not walk the user back to
 *    a spinner after they have been shown a code to type.
 * 2. **A wait must be visible and bounded.** A spinner with no end in sight is
 *    indistinguishable from a hang.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ErrorBoundary,
  Spinner,
  StatusBadge,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

interface Profile {
  name: string;
  path: string;
  hasCredential: boolean;
  lastRefresh?: string;
  pooled?: number;
  problem?: string;
}

interface Status {
  state: "idle" | "starting" | "awaiting_authorization" | "verifying" | "succeeded" | "failed";
  profile?: string;
  url?: string;
  userCode?: string;
  reason?: string;
  transcript?: string;
}

/**
 * The host applies an aggressive CSS reset to plugin UI, so a bare <a> is
 * indistinguishable from a sentence. Every control is styled explicitly, with
 * host CSS variables where they exist so the panel follows the active theme.
 */
const CONTROL: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "8px 14px",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.2,
  cursor: "pointer",
  textDecoration: "none",
  border: "1px solid transparent",
  fontFamily: "inherit",
};
const PRIMARY: React.CSSProperties = {
  ...CONTROL,
  background: "var(--primary, #6366f1)",
  color: "var(--primary-foreground, #ffffff)",
};
const SECONDARY: React.CSSProperties = {
  ...CONTROL,
  background: "transparent",
  color: "inherit",
  borderColor: "var(--border, #3f3f46)",
};
const CARD: React.CSSProperties = {
  border: "1px solid var(--border, #3f3f46)",
  borderRadius: 10,
  padding: 16,
  marginBottom: 12,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const MUTED: React.CSSProperties = { opacity: 0.7, fontSize: 13 };
const CODE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 24,
  letterSpacing: 2,
  fontWeight: 700,
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--muted, #27272a)",
  display: "inline-block",
};

const POLL_MS = 1500;

export function HermesCodexAuthSettingsPage({ context }: PluginWidgetProps) {
  if (!context.companyId) {
    return <div style={{ padding: 16 }}>Open this page inside a company.</div>;
  }
  return (
    <ErrorBoundary>
      <Panel companyId={context.companyId} />
    </ErrorBoundary>
  );
}

function Panel({ companyId }: { companyId: string }) {
  const listProfiles = usePluginAction("profiles");
  const start = usePluginAction("start");
  const poll = usePluginAction("poll");
  const cancel = usePluginAction("cancel");
  const verify = usePluginAction("verify");
  const toast = usePluginToast();

  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profilesRoot, setProfilesRoot] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  const refresh = useCallback(async () => {
    try {
      const result = (await listProfiles({})) as {
        profiles: Profile[];
        profilesRoot: string;
      };
      setProfiles(result.profiles ?? []);
      setProfilesRoot(result.profilesRoot ?? "");
    } catch (error) {
      toast({ title: "Could not read Hermes profiles", body: error instanceof Error ? error.message : "", tone: "error" });
      setProfiles([]);
    }
  }, [listProfiles, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while a sign-in is actually live.
  useEffect(() => {
    const live =
      status.state === "starting" ||
      status.state === "awaiting_authorization" ||
      status.state === "verifying";
    if (!live) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = (await poll({})) as Status;
        if (cancelled) return;
        // Progress is one-way: never fall back to `starting` once a code is up.
        if (
          next.state === "starting" &&
          statusRef.current.state === "awaiting_authorization"
        ) {
          return;
        }
        setStatus(next);
        if (next.state === "succeeded") {
          toast({ title: "Signed in", body: `Profile ${next.profile} now holds a working Codex credential.`, tone: "success" });
          setBusy(null);
          void refresh();
        } else if (next.state === "failed") {
          setBusy(null);
        }
      } catch (error) {
        if (cancelled) return;
        setStatus({ state: "failed", reason: error instanceof Error ? error.message : "Poll failed." });
        setBusy(null);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status.state, poll, refresh, toast]);

  // A visible, counted wait. See rule 2 at the top of this file.
  useEffect(() => {
    if (status.state !== "awaiting_authorization" && status.state !== "verifying") {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [status.state]);

  const onStart = useCallback(
    async (name: string) => {
      setBusy(name);
      setStatus({ state: "starting", profile: name });
      try {
        setStatus((await start({ profile: name })) as Status);
      } catch (error) {
        setStatus({
          state: "failed",
          profile: name,
          reason: error instanceof Error ? error.message : "Could not start the sign-in.",
        });
        setBusy(null);
      }
    },
    [start],
  );

  const onCancel = useCallback(async () => {
    try {
      await cancel({});
    } finally {
      setStatus({ state: "idle" });
      setBusy(null);
      void refresh();
    }
  }, [cancel, refresh, toast]);

  const onVerify = useCallback(
    async (name: string) => {
      setTesting(name);
      try {
        const result = (await verify({ profile: name })) as { ok: boolean; reason?: string };
        if (result.ok) toast({ title: "Credential works", body: `${name} authenticated against the provider.`, tone: "success" });
        else toast({ title: "Credential failed", body: `${name}: ${result.reason ?? "the test did not pass."}`, tone: "error" });
      } catch (error) {
        toast({ title: "The test could not run", body: error instanceof Error ? error.message : "", tone: "error" });
      } finally {
        setTesting(null);
      }
    },
    [verify, toast],
  );

  if (profiles === null) {
    return (
      <div style={{ padding: 16 }}>
        <Spinner size="sm" label="Reading Hermes profiles" />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>Hermes Codex Sign-in</h2>
      <p style={MUTED}>
        Each Hermes profile holds its own OpenAI Codex credential. Sign in once per profile — a
        Codex refresh token rotates, so two agents sharing one copy will eventually sign each
        other out.
      </p>

      {status.state !== "idle" && status.profile ? (
        <ActiveSignIn
          status={status}
          elapsed={elapsed}
          onCancel={onCancel}
          onDismiss={() => setStatus({ state: "idle" })}
        />
      ) : null}

      {profiles.length === 0 ? (
        <div style={CARD}>
          <strong>No Hermes profiles found.</strong>
          <span style={MUTED}>
            Looked in <code>{profilesRoot}</code>. Set the profiles directory in this plugin's
            settings if Hermes keeps them elsewhere.
          </span>
        </div>
      ) : (
        profiles.map((profile) => (
          <div key={profile.name} style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15 }}>{profile.name}</strong>
              <StatusBadge
                label={profile.hasCredential ? "Signed in" : "Not signed in"}
                status={profile.hasCredential ? "ok" : "warning"}
              />
              {typeof profile.pooled === "number" && profile.pooled > 1 ? (
                <span style={MUTED}>{profile.pooled} pooled credentials</span>
              ) : null}
            </div>
            {profile.problem ? <span style={MUTED}>{profile.problem}</span> : null}
            {profile.lastRefresh ? (
              <span style={MUTED}>Last refreshed {profile.lastRefresh}</span>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                style={PRIMARY}
                disabled={busy !== null}
                onClick={() => void onStart(profile.name)}
              >
                {profile.hasCredential ? "Sign in again" : "Sign in"}
              </button>
              {profile.hasCredential ? (
                <button
                  type="button"
                  style={SECONDARY}
                  disabled={testing !== null}
                  onClick={() => void onVerify(profile.name)}
                >
                  {testing === profile.name ? "Testing…" : "Test credential"}
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ActiveSignIn({
  status,
  elapsed,
  onCancel,
  onDismiss,
}: {
  status: Status;
  elapsed: number;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (status.state === "failed") {
    return (
      <div style={{ ...CARD, borderColor: "var(--destructive, #ef4444)" }}>
        <strong>Sign-in failed — {status.profile}</strong>
        <span style={MUTED}>{status.reason ?? "The sign-in did not complete."}</span>
        {status.transcript ? <Transcript text={status.transcript} /> : null}
        <div>
          <button type="button" style={SECONDARY} onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (status.state === "succeeded") {
    return (
      <div style={CARD}>
        <strong>Signed in — {status.profile}</strong>
        <span style={MUTED}>The credential was stored and tested against the provider.</span>
        <div>
          <button type="button" style={SECONDARY} onClick={onDismiss}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (status.state === "awaiting_authorization" && status.url && status.userCode) {
    return (
      <div style={CARD}>
        <strong>Finish signing in — {status.profile}</strong>
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 10 }}>
          <li>
            <a style={PRIMARY} href={status.url} target="_blank" rel="noreferrer noopener">
              Open the OpenAI sign-in page
            </a>
          </li>
          <li>
            Enter this code:
            <div style={{ marginTop: 6 }}>
              <span style={CODE}>{status.userCode}</span>
            </div>
          </li>
        </ol>
        <span style={MUTED}>
          <Spinner size="sm" label={`Waiting for approval… ${elapsed}s`} />
        </span>
        <div>
          <button type="button" style={SECONDARY} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={CARD}>
      <Spinner
        size="sm"
        label={
          status.state === "verifying"
            ? `Testing the new credential… ${elapsed}s`
            : "Starting the sign-in…"
        }
      />
      <div>
        <button type="button" style={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Subprocess output. Rendered as escaped React text, never as HTML, and never
 * passed to a model — see the warning on `PublicStatus.transcript`.
 */
function Transcript({ text }: { text: string }) {
  return (
    <details>
      <summary style={{ cursor: "pointer", ...MUTED }}>Show details</summary>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 12,
          maxHeight: 240,
          overflow: "auto",
          background: "var(--muted, #27272a)",
          padding: 12,
          borderRadius: 8,
        }}
      >
        {text}
      </pre>
    </details>
  );
}

export default HermesCodexAuthSettingsPage;
