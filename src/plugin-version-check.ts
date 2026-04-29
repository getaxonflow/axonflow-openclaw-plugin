/**
 * Plugin/platform version compatibility check.
 *
 * Mirrors the SDK pattern: the plugin queries the platform's /health,
 * reads `plugin_compatibility.min_plugin_version["openclaw"]`, and
 * logs a one-time upgrade warning when its own runtime version is
 * below the floor the platform expects.
 *
 * The check is fire-and-forget — if the platform doesn't advertise
 * the field (older platforms) or the request fails, the plugin keeps
 * working silently. The warning is informational; nothing in the
 * plugin's hot path depends on the result.
 *
 * Plugin id `"openclaw"` matches the canonical id in
 * `axonflow-enterprise/platform/agent/integration_activation.go` and
 * `getPluginCompatibility()` in capabilities.go.
 */

import type { AxonFlowClient } from "./axonflow-client.js";

export const PLUGIN_ID = "openclaw";

export interface VersionCheckLogger {
  warn?: (msg: string) => void;
  info?: (msg: string) => void;
}

/**
 * Compare two semver-ish version strings.
 *
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`. Treats invalid /
 * pre-release / build-metadata segments by stripping them and comparing
 * the major.minor.patch numeric prefix only — adequate for the
 * downgrade-warning gate, which only cares about ordering of the
 * canonical numeric tuple.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(/[-+]/, 1)[0]!.split(".").map((p) => Number(p) | 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Run the plugin/platform version compatibility check and emit a
 * single log line on the result.
 *
 * - If the platform doesn't advertise plugin_compatibility (older
 *   platform or unparseable response), no log line is emitted —
 *   absence of signal is not a regression.
 * - If the plugin runtime version is below `min_plugin_version`,
 *   logger.warn is called with an upgrade hint.
 * - If the plugin is at or above the floor but below the recommended
 *   version, logger.info is called (informational).
 *
 * Exceptions are swallowed — the check must not prevent plugin
 * startup or affect the hook hot path.
 */
export async function runPluginVersionCheck(
  client: Pick<AxonFlowClient, "getPluginCompatibility">,
  pluginVersion: string,
  logger: VersionCheckLogger,
): Promise<void> {
  let compat;
  try {
    compat = await client.getPluginCompatibility();
  } catch {
    return;
  }
  if (!compat) return;

  const min = compat.minPluginVersion[PLUGIN_ID];
  const recommended = compat.recommendedPluginVersion[PLUGIN_ID];

  if (min && compareVersions(pluginVersion, min) < 0) {
    const msg =
      `AxonFlow @axonflow/openclaw v${pluginVersion} is below the platform's ` +
      `minimum supported version (v${min}). Upgrade with ` +
      `\`npm install @axonflow/openclaw@latest\` — older releases may mis-handle ` +
      `newer platform contract fields.`;
    if (logger.warn) {
      logger.warn(msg);
    }
    return;
  }
  if (recommended && compareVersions(pluginVersion, recommended) < 0) {
    const msg =
      `AxonFlow @axonflow/openclaw v${pluginVersion} is below the recommended ` +
      `version (v${recommended}). Plugin will keep working; upgrade for the ` +
      `full feature set.`;
    if (logger.info) {
      logger.info(msg);
    }
  }
}
