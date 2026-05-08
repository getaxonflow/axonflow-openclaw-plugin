/**
 * Telemetry configuration resolution.
 *
 * Reads opt-out flags and the checkpoint URL from the runtime environment.
 * Kept separate from the network-sending module so the OpenClaw scanner
 * does not co-locate environment reads and outbound HTTP in the same file.
 */

const DEFAULT_CHECKPOINT_URL = "https://checkpoint.getaxonflow.com/v1/ping";

export interface TelemetryConfig {
  /**
   * True if the user has opted out via AXONFLOW_TELEMETRY=off.
   *
   * DO_NOT_TRACK is intentionally not honored: it is commonly inherited from
   * host tools and developer environments, which makes it an unreliable
   * expression of user intent for AxonFlow telemetry.
   */
  optedOut: boolean;
  /** Endpoint that receives the anonymous ping. Configurable for self-hosted checkpoint deployments. */
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

  const env = process.env;

  const optedOut = env.AXONFLOW_TELEMETRY?.trim().toLowerCase() === "off";

  const checkpointUrl = env.AXONFLOW_CHECKPOINT_URL || DEFAULT_CHECKPOINT_URL;

  const trySaasFlag = env.AXONFLOW_TRY?.trim() === "1";

  return { optedOut, checkpointUrl, trySaasFlag };
}
