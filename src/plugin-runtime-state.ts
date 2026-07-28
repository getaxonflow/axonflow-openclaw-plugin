/**
 * Bridge between the governance runtime and the standalone status CLI.
 *
 * `bin/axonflow-openclaw-status.mjs` runs as its own process, outside the
 * OpenClaw host, so it has no access to `pluginConfig` — the channel most
 * self-hosted operators configure. Through v2.8.4 it therefore resolved the
 * endpoint from the environment alone and reported the Community SaaS to
 * operators whose governed traffic was going to their own stack (#167).
 *
 * This module closes that gap by recording, at every plugin load, the raw
 * pluginConfig values that feed the deployment decision. The CLI reads them
 * back and hands them to `resolveDeploymentTarget` — the SAME function the
 * runtime uses — so both surfaces run one resolution, not two.
 *
 * WHAT IS RECORDED: inputs, never the answer.
 *
 * Recording the resolved endpoint would make the file a cache that goes
 * stale the moment `AXONFLOW_ENDPOINT` changes in the reader's shell.
 * Recording the inputs instead means the highest-precedence source (the
 * environment) is always read live at CLI time, and the file only supplies
 * the lower-precedence value the reader genuinely cannot observe. A stale
 * env value cannot win, because no env value is ever stored.
 *
 * The record is rewritten on every plugin load, so any configuration change
 * the runtime picks up is reflected here as well. The residual case — the
 * user edits `pluginConfig` and the OpenClaw runtime has not reloaded the
 * plugin yet — is reported rather than hidden: `resolveStatusInputs` carries
 * the record's timestamp through to the status report, and the CLI prints it
 * next to the endpoint. In that window the record still describes what the
 * running runtime is actually doing, which is what the status surface is
 * asked about.
 *
 * `axonflow_get_tenant_id` runs inside the runtime process and is passed the
 * live `pluginConfig` directly, so it never consults this file at all.
 *
 * NO CREDENTIALS ARE WRITTEN. `clientSecret`, `licenseToken` and `userToken`
 * are excluded. `clientId` is a tenant identifier, not a secret, and the
 * endpoint is already emitted in cleartext by the init canary. The file is
 * still written 0600 inside the 0700 config dir, matching every other file
 * the plugin persists.
 */

import * as fs from "fs";
import * as path from "path";
import {
  ensureSecureDir,
  writeFileAtomicallyWithMode,
} from "./community-saas-context.js";

/** Filename under the AxonFlow config dir. */
export const RUNTIME_STATE_FILE_NAME = "openclaw-plugin-runtime-state.json";

/**
 * Record format version. Bumped whenever the meaning of a field changes;
 * readers ignore any record whose version they do not understand and fall
 * back to environment-only resolution (the pre-#167 behaviour), which is
 * degraded but never wrong about the environment.
 */
export const RUNTIME_STATE_SCHEMA = 1;

/**
 * The subset of pluginConfig that feeds `resolveDeploymentTarget`.
 *
 * `clientSecret` is deliberately absent. It participates in the deployment
 * decision only through the "user provided credentials" test, and
 * `resolveConfig` refuses to load a config that sets `clientSecret` without
 * `clientId` — so for any config that loaded successfully, `clientId` alone
 * carries the same signal.
 */
export interface PluginConfigView {
  endpoint: string;
  clientId: string;
}

/** On-disk record. */
export interface PluginRuntimeState {
  schema: number;
  /** ISO-8601 timestamp of the plugin load that wrote this record. */
  recorded_at: string;
  /** Plugin version that wrote the record — diagnostic only. */
  plugin_version: string;
  plugin_config: PluginConfigView;
}

/** Absolute path of the record, or "" when no config dir is resolvable. */
export function runtimeStatePath(configDir: string): string {
  if (!configDir) return "";
  return path.join(configDir, RUNTIME_STATE_FILE_NAME);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Project the raw pluginConfig blob down to the recordable view.
 * Pure — no env, no fs.
 */
export function buildPluginConfigView(
  pluginConfig: Record<string, unknown> | undefined,
): PluginConfigView {
  const cfg = pluginConfig ?? {};
  return {
    endpoint: trimmedString(cfg["endpoint"]),
    clientId: trimmedString(cfg["clientId"]),
  };
}

/**
 * Record the pluginConfig view for the standalone CLI.
 *
 * Best-effort: returns false on any failure (unresolvable config dir,
 * read-only home, permission error) and never throws. A missing record just
 * degrades the CLI to environment-only resolution.
 */
export function writePluginRuntimeState(
  configDir: string,
  pluginConfig: Record<string, unknown> | undefined,
  pluginVersion: string,
  now: () => Date = () => new Date(),
): boolean {
  const file = runtimeStatePath(configDir);
  if (!file) return false;
  if (!ensureSecureDir(configDir)) return false;
  const state: PluginRuntimeState = {
    schema: RUNTIME_STATE_SCHEMA,
    recorded_at: now().toISOString(),
    plugin_version: pluginVersion,
    plugin_config: buildPluginConfigView(pluginConfig),
  };
  try {
    writeFileAtomicallyWithMode(file, JSON.stringify(state), 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read back a record written by a previous plugin load.
 *
 * Returns null when the file is missing, unreadable, not an object, or
 * carries a schema version this build does not understand. Never throws —
 * the status surface must degrade gracefully rather than fail.
 *
 * Unlike the registration file, permissions are NOT enforced on read: the
 * record holds no credential, and refusing to read it would silently return
 * the status surface to the exact wrong answer #167 is about.
 */
export function readPluginRuntimeState(file: string): PluginRuntimeState | null {
  if (!file) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record["schema"] !== RUNTIME_STATE_SCHEMA) {
    return null;
  }
  const rawConfig = record["plugin_config"];
  const configBlob =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>)
      : {};
  return {
    schema: RUNTIME_STATE_SCHEMA,
    recorded_at: trimmedString(record["recorded_at"]),
    plugin_version: trimmedString(record["plugin_version"]),
    plugin_config: {
      endpoint: trimmedString(configBlob["endpoint"]),
      clientId: trimmedString(configBlob["clientId"]),
    },
  };
}
