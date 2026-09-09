import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const SLOT_IDS = {
  settingsPage: "hermes-codex-auth-settings-page",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "HermesCodexAuthSettingsPage",
} as const;

export const ACTIONS = {
  profiles: "profiles",
  start: "start",
  poll: "poll",
  cancel: "cancel",
  verify: "verify",
  diagnostics: "diagnostics",
} as const;

/**
 * `local.folders` **is** required here, unlike the sibling Claude plugin.
 *
 * That plugin never touched the filesystem: `claude setup-token` prints a token
 * and the human stores it as a company secret. Hermes has no such artifact — it
 * writes `auth.json` into the profile directory itself, so listing profiles and
 * confirming a credential landed are both filesystem reads. Nothing is written
 * by this plugin; Hermes does the writing.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "ordillect.hermes-codex-auth",
  apiVersion: 1,
  version: "1.0.1",
  displayName: "Hermes Codex Sign-in",
  description:
    "Sign a Hermes agent in to OpenAI Codex from the Paperclip UI. Runs the device-code login per Hermes profile, so each agent holds its own credential rather than sharing one that rotates.",
  author: "Michal Takáč <hello@michaltakac.com>",
  categories: ["workspace"],
  capabilities: [
    "instance.settings.register",
    "ui.action.register",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "local.folders",
  ],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui/",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      hermesPath: {
        type: "string",
        title: "Path to the Hermes CLI",
        description:
          "Absolute path to the `hermes` executable. Leave blank to auto-detect: a virtualenv install at <venv>/bin/hermes is tried before PATH.",
        default: "",
      },
      profilesRoot: {
        type: "string",
        title: "Hermes profiles directory",
        description:
          "Directory holding one subdirectory per Hermes profile. Each is used verbatim as HERMES_HOME for its own sign-in.",
        default: "/paperclip/.hermes/profiles",
      },
      scriptPath: {
        type: "string",
        title: "Path to `script`",
        description:
          "util-linux `script`, used to allocate the pseudo-terminal the device-code login requires.",
        default: "/usr/bin/script",
      },
      verify: {
        type: "boolean",
        title: "Verify the credential after signing in",
        description:
          "Runs one minimal Hermes call to prove the credential works. A status check alone does not.",
        default: true,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Hermes Codex Sign-in",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
