# paperclip-hermes-codex-auth

Sign a **Hermes** agent in to **OpenAI Codex** from the Paperclip UI — no terminal,
one profile at a time.

[Paperclip](https://github.com/paperclipai/paperclip) runs Hermes agents through the
`hermes_local` adapter. That adapter deliberately defers all authentication to Hermes'
own configuration, and Paperclip's managed-Codex-home machinery applies to the
`codex_local` adapter only. So on a self-hosted instance, a Hermes agent with no Codex
credential fails at dispatch with:

```
No Codex credentials stored. Run `hermes auth` to authenticate.
```

…and the only fix is a human with shell access running an interactive login inside the
container. This plugin turns that into a button.

## Why per profile, and not one login for everything

The Hermes adapter sets `HERMES_HOME` to the **profile directory**, and Hermes stores
its OAuth state in `auth.json` at that root. So a profile is the unit of authentication.

It is tempting to sign in once and copy `auth.json` everywhere. Don't. A Codex OAuth
credential carries a **refresh token that rotates**: two runtimes sharing one copy will
refresh independently and invalidate each other, and the symptom — a sudden "credentials
expired" on a machine nobody touched — is thoroughly confusing to debug.

This plugin therefore lists your profiles and signs each in on its own. The panel makes
that visible rather than implying one login covers everyone.

## What it does

- Lists every profile under the configured profiles directory, with live credential state
  read from `auth.json` (presence, last refresh, pooled credential count).
- Runs `hermes auth add openai-codex --type oauth --no-browser` on a pseudo-terminal,
  surfaces the device URL as a button and the user code as large text, and polls.
- **Verifies** the result with one real Hermes round trip before reporting success.
- Offers a "Test credential" button per profile, for when an agent starts failing and you
  want to know whether the credential is the reason.

## Install

Plugin Manager → Install Plugin → `paperclip-hermes-codex-auth`.
Then Settings → Plugins → **Hermes Codex Sign-in**.

### Configuration

| Setting | Default | Notes |
|---|---|---|
| `hermesPath` | *(auto-detect)* | Leave blank and the plugin tries `/paperclip/hermes-venv/bin/hermes`, then the usual system paths, then `PATH`. Set it explicitly if Hermes lives elsewhere. |
| `profilesRoot` | `/paperclip/.hermes/profiles` | One subdirectory per profile. Each is used verbatim as `HERMES_HOME`. |
| `scriptPath` | `/usr/bin/script` | util-linux `script`, used to allocate the PTY. |
| `verify` | `true` | Run a real round trip after signing in. Leave it on; see below. |

## Updating

The panel shows the installed version and offers an **Update** button.

This exists because Paperclip has no plugin-update UI. The host implements
upgrade fully — `POST /api/plugins/:id/upgrade` deactivates the runtime, downloads
and validates the new package, diffs the manifest capabilities, and either parks the
plugin in `upgrade_pending` for operator approval or returns it to ready and
reactivates — and `pluginsApi.upgrade()` exists in the host's own API client. Nothing
calls it. So an installed plugin otherwise has no way to ship a fix to the people
running it.

The upgrade runs as the signed-in human, from plugin UI that is same-origin with the
Paperclip app, and needs instance-admin rights. It is deliberately **not** done from
the worker: a worker-side upgrade would be the plugin escalating itself.

After a successful update the running page still holds the old UI bundle — the host
swapped the worker underneath it — so the button turns into **Reload to finish**.

If the new version requests capabilities the installed one did not, the host holds it
in `upgrade_pending` for an administrator. That is the capability gate working, and the
panel says so rather than reporting a failure.

## Design notes

**A PTY is mandatory.** Run with pipe stdio, the login emits *zero bytes* and waits — the
device-code prompt only renders on a terminal. Rather than take a native `node-pty`
dependency (a build toolchain in every host image), this borrows the PTY that util-linux
`script` already allocates, which keeps the plugin pure JavaScript and installable from
npm anywhere Paperclip runs. The BSD/macOS `script` takes different arguments and is not
supported.

**The device-code flow is undocumented.** The Hermes CLI reference states OAuth is "still
browser-based; no device-code alternative documented" — but `--no-browser` on 0.18.2
prints a device URL and a user code and polls for approval. The parser's test fixture is
the exact byte sequence observed, because that is the only specification of this flow
that exists. Re-run the tests after a Hermes upgrade.

**Success is not parsed.** Hermes writes the credential itself, so the session observes
`auth.json` plus the process exit code rather than matching a success banner upstream is
free to reword.

**Presence is not validity.** `hermes auth status` answers "a credential is present",
which is a different question from "a credential works" — an expired refresh token looks
exactly like a live one. Only a real round trip distinguishes them, so that is what the
verification step does. This is the same lesson that
[`paperclip-claude-auth`](https://github.com/michaltakac/paperclip-claude-auth) learned
from `claude auth status`, which cheerfully reports `loggedIn: true` for a bogus token.

**No credential passes through this plugin.** It reads presence and metadata from
`auth.json` and never loads a token. There is no code path here that reads an access or
refresh token, which is why there is no code path that can leak one.

**The device code is redacted** from every transcript and log. While a flow is open it is
a live second factor, so a sign-in is owned by the person who started it and another
principal cannot poll it.

**Hermes is usually not on `PATH`.** It is commonly a Python virtualenv install, so the
executable never lands in `/usr/local/bin`. A wrong path is not merely inconvenient: it
surfaces as "executable not found" against a profile the panel has just badged *Signed
in*, which reads as a broken credential rather than a missing setting. So the path is
auto-detected, and when detection fails the error names every location tried.

**A rebuilt bundle does not reload** until the plugin is disabled and re-enabled. The
worker logs its version at startup so "which build is live" is answerable from the logs.

## Development

```bash
npm install
npm test          # parser fixtures, profile discovery, probe interpretation
npm run typecheck
npm run build
```

Local install (source must sit inside the host's bind mount so the container can see it):

```
<paperclip-data>/plugin-src/paperclip-hermes-codex-auth  →  /paperclip/plugin-src/...
POST /api/plugins/install  {"packageName": "<abs path>", "isLocalPath": true}
```

The install *dialog* only accepts npm names, though the API, CLI and install guard all
support local paths. Two things reliably bite on a source install: a root-owned npm cache
gives `EACCES` (`chown -R 1000:1000` the plugin and npm cache directories), and
`NODE_ENV=production` makes a bare `npm install` skip devDependencies, so the build fails
on a missing `esbuild`.

## Status

Tested against Hermes Agent 0.18.2 with the `hermes_local` adapter. The device-code
flow is undocumented upstream and could change without notice.

## License

MIT
