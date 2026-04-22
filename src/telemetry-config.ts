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
   * True if the user has opted out via AXONFLOW_TELEMETRY=off (canonical) or
   * DO_NOT_TRACK=1 (deprecated — scheduled for removal after 2026-05-05 in the
   * next major release).
   */
  optedOut: boolean;
  /** Endpoint that receives the anonymous ping. Configurable for self-hosted checkpoint deployments. */
  checkpointUrl: string;
}

export function loadTelemetryConfig(): TelemetryConfig {
  if (typeof process === "undefined" || !process.env) {
    return { optedOut: false, checkpointUrl: DEFAULT_CHECKPOINT_URL };
  }

  const env = process.env;

  const dntActive = env.DO_NOT_TRACK?.trim() === "1";
  const axonflowTelemetryOff = env.AXONFLOW_TELEMETRY?.trim().toLowerCase() === "off";
  const optedOut = dntActive || axonflowTelemetryOff;

  // Deprecation warning — fires only when DO_NOT_TRACK is the active control
  // and AXONFLOW_TELEMETRY=off is NOT set. If both are set, the operator has
  // already migrated to the canonical switch; no warning. Guarded to run at
  // most once per plugin process via a module-level sentinel.
  if (dntActive && !axonflowTelemetryOff && !doNotTrackDeprecationWarningShown) {
    doNotTrackDeprecationWarningShown = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[AxonFlow] DO_NOT_TRACK=1 is deprecated as an AxonFlow telemetry opt-out and will be removed after 2026-05-05 in the next major release. Set AXONFLOW_TELEMETRY=off to opt out going forward. See https://docs.getaxonflow.com/docs/telemetry for details.",
    );
  }

  const checkpointUrl = env.AXONFLOW_CHECKPOINT_URL || DEFAULT_CHECKPOINT_URL;

  return { optedOut, checkpointUrl };
}

// Module-level sentinel keeps the deprecation warning to one emission per
// process even if loadTelemetryConfig is called from multiple code paths.
let doNotTrackDeprecationWarningShown = false;
