/**
 * Anonymous usage telemetry for the OpenClaw plugin.
 *
 * Sends a single fire-and-forget ping on plugin initialization to
 * checkpoint.getaxonflow.com. Collects SDK version, platform info,
 * and OpenClaw version. No PII, no tool arguments, no policy data.
 *
 * Opt out: DO_NOT_TRACK=1 or AXONFLOW_TELEMETRY=off
 *
 * Configuration resolution (opt-out flags and checkpoint URL) lives in
 * telemetry-config.ts so this file only handles the network-sending side.
 */

import { loadTelemetryConfig } from "./telemetry-config.js";

const TELEMETRY_TIMEOUT_MS = 3000;

function generateInstanceId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to fallback
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface TelemetryPayload {
  sdk: string;
  sdk_version: string;
  platform_version: string | null;
  os: string;
  arch: string;
  runtime_version: string;
  deployment_mode: string;
  features: string[];
  instance_id: string;
}

/**
 * Detect the AxonFlow platform version via /health endpoint.
 */
async function detectPlatformVersion(
  endpoint: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`${endpoint}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;
    const body = (await resp.json()) as Record<string, unknown>;
    return typeof body.version === "string" && body.version
      ? body.version
      : null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Send an anonymous telemetry ping on plugin initialization.
 *
 * Fire-and-forget: errors are silently swallowed, 3-second timeout
 * prevents blocking. Never affects plugin behavior.
 */
export function sendTelemetryPing(options: {
  endpoint: string;
  pluginVersion: string;
  hookCount: number;
  highRiskToolCount: number;
  onError: string;
}): void {
  const config = loadTelemetryConfig();
  if (config.optedOut) {
    return;
  }

  if (typeof console !== "undefined") {
    console.log(
      "[AxonFlow] Anonymous telemetry enabled for local and self-hosted use. Opt out: DO_NOT_TRACK=1 or AXONFLOW_TELEMETRY=off | https://docs.getaxonflow.com/docs/telemetry",
    );
  }

  // Runtime metadata (platform, arch, runtime version) for the payload.
  const proc = typeof process !== "undefined" ? process : null;

  const payload: TelemetryPayload = {
    sdk: "openclaw-plugin",
    sdk_version: options.pluginVersion,
    platform_version: null,
    os: proc ? proc.platform : "unknown",
    arch: proc ? proc.arch : "unknown",
    runtime_version: proc ? proc.version.replace(/^v/, "") : "unknown",
    deployment_mode: options.onError === "block" ? "production" : "development",
    features: [
      `hooks:${options.hookCount}`,
      `high_risk_tools:${options.highRiskToolCount}`,
      `on_error:${options.onError}`,
    ],
    instance_id: generateInstanceId(),
  };

  try {
    void (async () => {
      try {
        payload.platform_version = await detectPlatformVersion(
          options.endpoint,
        );
      } catch {
        // Silent — platform version remains null
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);

      try {
        await fetch(config.checkpointUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    })().catch(() => {
      // Silent failure — telemetry should never affect plugin behavior
    });
  } catch {
    // Silent failure
  }
}
