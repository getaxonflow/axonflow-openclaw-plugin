/**
 * Bridge between the governance runtime and the standalone status CLI.
 *
 * `bin/axonflow-openclaw-status.mjs` runs as its own process, outside the
 * OpenClaw host, so it can see neither `pluginConfig` nor the environment
 * the runtime was started with. Through v2.8.4 it therefore resolved from
 * its own environment alone and reported the Community SaaS to operators
 * whose governed traffic was going to their own stack (#167).
 *
 * This module closes that gap by recording, at every plugin load, the
 * user-provided inputs that fed the deployment decision. The CLI reads them
 * back and hands them to `resolveDeploymentTarget` — the SAME function the
 * runtime uses — so both surfaces run one resolution, not two.
 *
 * WHAT IS RECORDED: the user's inputs, not the resolved answer.
 *
 * `endpointOverride` is the value `resolveEndpointOverride` returned at
 * load: `AXONFLOW_ENDPOINT` if the runtime's environment carried one, else
 * `pluginConfig.endpoint`, else "". Both channels have to be covered —
 * recording only `pluginConfig` leaves an operator who configures through
 * the environment (a first-class, documented channel) with exactly the
 * v2.8.4 wrong answer whenever the CLI is run from a shell that does not
 * export the variable. `endpointSource` is kept alongside so the display
 * can say which channel it came from.
 *
 * What is NOT recorded is the resolved endpoint, mode or identity. Those
 * stay derived, so the reader's LIVE environment is always applied on top:
 * `resolveEndpointOverride` consults `AXONFLOW_ENDPOINT` before falling
 * back to the value handed to it, which means a recorded value fills a gap
 * but can never outrank the environment the CLI is actually run in.
 *
 * The record is rewritten on every plugin load, so any configuration change
 * the runtime picks up is reflected here too. The residual case — the user
 * edits configuration and the OpenClaw runtime has not reloaded the plugin
 * yet — is reported rather than hidden: `resolveStatusInputs` carries the
 * record's timestamp through to the status report, and the CLI prints it,
 * but ONLY when the record actually contributed a value. A record that
 * contributed nothing must not decorate an environment-only answer with a
 * timestamp that reads as "I consulted the running runtime".
 *
 * `axonflow_get_tenant_id` runs inside the runtime process and is passed the
 * live `pluginConfig` directly, so it never consults this file at all.
 *
 * KNOWN LIMIT — one record per config dir. Two OpenClaw hosts started with
 * different plugin configurations against the same `AXONFLOW_CONFIG_DIR` share
 * this file, and the last load wins. The CLI then reports that configuration —
 * with a provenance timestamp — to whichever session asks, which is a true
 * statement about the most recent load and a misleading one about the other
 * session. Point the hosts at separate `AXONFLOW_CONFIG_DIR`s to keep their
 * status surfaces independent; the runtimes themselves are unaffected either
 * way, since each governs from its own in-process config.
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
import { resolveEndpointOverrideWithSource } from "./endpoint-env.js";

/** Filename under the AxonFlow config dir. */
export const RUNTIME_STATE_FILE_NAME = "openclaw-plugin-runtime-state.json";

/**
 * Record format version. Bumped whenever the meaning of a field changes;
 * readers ignore any record whose version they do not understand and fall
 * back to environment-only resolution (the pre-#167 behaviour), which is
 * degraded but never wrong about the environment.
 *
 * v2: `plugin_config.endpoint` (pluginConfig only) became
 * `endpoint_override` + `endpoint_source`, covering the `AXONFLOW_ENDPOINT`
 * channel that v1 silently dropped.
 */
export const RUNTIME_STATE_SCHEMA = 2;

/** Which channel supplied the endpoint override the runtime resolved. */
export type EndpointSource = "env" | "plugin-config" | "none";

/**
 * The user-provided inputs that feed `resolveDeploymentTarget`.
 *
 * `clientSecret` is deliberately absent. It participates in the deployment
 * decision only through the "user provided credentials" test, and
 * `resolveConfig` refuses to load a config that sets `clientSecret` without
 * `clientId` — so for any config that loaded successfully, `clientId` alone
 * carries the same signal.
 */
export interface RecordedRuntimeInputs {
  /** `AXONFLOW_ENDPOINT` if the runtime's env carried one, else pluginConfig.endpoint, else "". */
  endpointOverride: string;
  /** Which channel `endpointOverride` came from. */
  endpointSource: EndpointSource;
  /** `pluginConfig.clientId`, trimmed. */
  clientId: string;
}

/** On-disk record. */
export interface PluginRuntimeState {
  schema: number;
  /** ISO-8601 timestamp of the plugin load that wrote this record. */
  recorded_at: string;
  /** Plugin version that wrote the record — diagnostic only. */
  plugin_version: string;
  endpoint_override: string;
  endpoint_source: EndpointSource;
  client_id: string;
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
 * Project the raw pluginConfig blob plus the current environment down to
 * the recordable inputs. Both the value AND the channel it came from are
 * taken from the resolver — no precedence logic, and no inference of the
 * channel by comparing values, lives here.
 */
export function buildRecordedRuntimeInputs(
  pluginConfig: Record<string, unknown> | undefined,
): RecordedRuntimeInputs {
  const cfg = pluginConfig ?? {};
  const resolved = resolveEndpointOverrideWithSource(cfg["endpoint"]);
  return {
    endpointOverride: resolved.endpoint,
    endpointSource: resolved.source,
    clientId: trimmedString(cfg["clientId"]),
  };
}

/**
 * Record the runtime's resolved inputs for the standalone CLI.
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
  const inputs = buildRecordedRuntimeInputs(pluginConfig);
  const state: PluginRuntimeState = {
    schema: RUNTIME_STATE_SCHEMA,
    recorded_at: now().toISOString(),
    plugin_version: pluginVersion,
    endpoint_override: inputs.endpointOverride,
    endpoint_source: inputs.endpointSource,
    client_id: inputs.clientId,
  };
  try {
    writeFileAtomicallyWithMode(file, JSON.stringify(state), 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell the operator when the record is group- or world-writable, so a planted
 * record cannot quietly steer the display. Best-effort and never throws: on
 * Windows, or when stat/stderr are unavailable, this is a no-op.
 */
function warnIfRecordPermissionsAreUnsafe(file: string): void {
  if (process.platform === "win32") return;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o022) === 0) return;
    process.stderr.write(
      `[AxonFlow] ${file} is writable by others (${mode.toString(8).padStart(3, "0")}); ` +
        "the endpoint and identity reported below may have been planted. " +
        "Reload the plugin to rewrite it, or remove it to fall back to this " +
        "shell's environment.\n",
    );
  } catch {
    /* stat or stderr unavailable — nothing useful to say */
  }
}

function readEndpointSource(value: unknown): EndpointSource {
  return value === "env" || value === "plugin-config" ? value : "none";
}

/**
 * Read back a record written by a previous plugin load.
 *
 * Returns null when the file is missing, unreadable, not an object, or
 * carries a schema version this build does not understand. Never throws —
 * the status surface must degrade gracefully rather than fail.
 *
 * Unlike the registration file, unsafe permissions do not make this reader
 * REFUSE — they make it warn. The record holds no credential, the reader's own
 * environment still outranks anything in it, and nothing here can change what
 * the runtime governs; whereas refusing would send the status surface straight
 * back to the environment-only answer #167 is about. So the asymmetry with
 * `readRegistrationIfFreshAndSafe` is closed by telling the operator, not by
 * withholding the answer.
 */
export function readPluginRuntimeState(file: string): PluginRuntimeState | null {
  if (!file) return null;
  warnIfRecordPermissionsAreUnsafe(file);
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
  return {
    schema: RUNTIME_STATE_SCHEMA,
    recorded_at: trimmedString(record["recorded_at"]),
    plugin_version: trimmedString(record["plugin_version"]),
    endpoint_override: trimmedString(record["endpoint_override"]),
    endpoint_source: readEndpointSource(record["endpoint_source"]),
    client_id: trimmedString(record["client_id"]),
  };
}
