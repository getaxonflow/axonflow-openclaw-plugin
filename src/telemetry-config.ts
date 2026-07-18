/**
 * Telemetry configuration resolution.
 *
 * Reads opt-out flags and the checkpoint URL from the runtime environment.
 * Reads opt-out flags and the checkpoint URL from the runtime environment.
 */

const DEFAULT_CHECKPOINT_URL = "https://checkpoint.getaxonflow.com/v1/ping";

export interface TelemetryConfig {
  /**
   * True if the user has opted out via AXONFLOW_TELEMETRY=off.
   *
   */
  optedOut: boolean;
  /** Endpoint that receives the heartbeat. Configurable for self-hosted checkpoint deployments. */
  checkpointUrl: string;
  /**
   * `AXONFLOW_TRY=1` opts the deployment-mode classifier into reporting
   * `community_saas` regardless of endpoint host. Provided so that
   * Community-SaaS tenants behind a custom hostname proxying
   * `try.getaxonflow.com` are still classified correctly.
   */
  trySaasFlag: boolean;
}

export function loadTelemetryConfig(): TelemetryConfig {
  if (typeof process === "undefined" || !process.env) {
    return {
      optedOut: false,
      checkpointUrl: DEFAULT_CHECKPOINT_URL,
      trySaasFlag: false,
    };
  }

  // Static named reads only — never alias/capture the full process.env
  // object in a module whose output feeds a network send.
  const raw = process.env.AXONFLOW_TELEMETRY?.trim().toLowerCase() ?? "";
  const optedOut = raw === "off" || raw === "0" || raw === "false" || raw === "no";

  const checkpointUrl = process.env.AXONFLOW_CHECKPOINT_URL || DEFAULT_CHECKPOINT_URL;

  const trySaasFlag = process.env.AXONFLOW_TRY?.trim() === "1";

  return { optedOut, checkpointUrl, trySaasFlag };
}
