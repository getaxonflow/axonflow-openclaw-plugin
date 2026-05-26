/**
 * Telemetry context — environment + filesystem reads.
 *
 * Collects runtime metadata (OS, arch, Node version) and manages the
 * heartbeat stamp file. The network-sending side lives in telemetry.ts;
 * this module provides the data it needs.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Resolve the endpoint that the telemetry probe should hit.
 *
 * Honours the test-only AXONFLOW_HARNESS override exclusively used by
 * tests/heartbeat-real-stack/. Production callers leave AXONFLOW_HARNESS
 * unset; the override is a no-op and the configured endpoint is returned.
 */
export function resolveProbeEndpoint(defaultEndpoint: string): string {
  const harnessOn = process.env["AXONFLOW_HARNESS"] === "1";
  const harnessAgent = process.env["AXONFLOW_HARNESS_AGENT_ENDPOINT"];
  if (harnessOn && harnessAgent && harnessAgent.length > 0) {
    return harnessAgent;
  }
  return defaultEndpoint;
}

/**
 * Stamp metadata read from the cache directory.
 *
 * `mtimeMs` is 0 when the stamp file does not exist (or its stat fails).
 * `priorInstanceId` is empty when the stamp file is unreadable or empty.
 */
export interface StampMetadata {
  exists: boolean;
  mtimeMs: number;
  priorInstanceId: string;
}

/**
 * Inspect the heartbeat stamp file. Returns existence + mtime + the prior
 * instance_id contents. Never throws — read failures resolve to "no stamp".
 */
export function readStampMetadata(stampFile: string): StampMetadata {
  if (!stampFile) {
    return { exists: false, mtimeMs: 0, priorInstanceId: "" };
  }
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(stampFile);
    mtimeMs = stat.mtimeMs;
  } catch {
    return { exists: false, mtimeMs: 0, priorInstanceId: "" };
  }
  let priorInstanceId = "";
  try {
    priorInstanceId = fs.readFileSync(stampFile, "utf8").trim();
  } catch {
    priorInstanceId = "";
  }
  return { exists: true, mtimeMs, priorInstanceId };
}

/**
 * Ensure the cache directory exists and is private (mode 0o700 on POSIX).
 * Returns the directory path on success or "" on any failure so callers can
 * fall back to "no persistence" without crashing the plugin load.
 */
export function ensureCacheDir(cacheDir: string): string {
  if (!cacheDir) return "";
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(cacheDir, 0o700); } catch { /* best effort */ }
    }
    return cacheDir;
  } catch {
    return "";
  }
}

/**
 * Atomically write the stamp file containing the current instance_id.
 * Uses tmp + rename so a partial write never leaves a half-stamp on disk.
 * Best-effort chmod 0o600 on POSIX.
 */
export function writeStampAtomic(stampFile: string, instanceId: string): void {
  if (!stampFile) return;
  try {
    const tmp = `${stampFile}.tmp.${process.pid ?? "x"}`;
    fs.writeFileSync(tmp, instanceId, { mode: 0o600 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    }
    fs.renameSync(tmp, stampFile);
  } catch {
    // We delivered but couldn't stamp. Next plugin init retries.
  }
}

/**
 * Snapshot of `process` runtime data used in the telemetry payload.
 * Captured alongside the other env/fs reads for module cohesion.
 */
export interface RuntimeInfo {
  os: string;
  arch: string;
  runtimeVersion: string;
}

export function captureRuntimeInfo(): RuntimeInfo {
  const proc = typeof process !== "undefined" ? process : null;
  return {
    os: proc ? proc.platform : "unknown",
    arch: proc ? proc.arch : "unknown",
    runtimeVersion: proc ? proc.version.replace(/^v/, "") : "unknown",
  };
}

/** Re-exported for callers that build the stamp path themselves. */
export const STAMP_FILE_NAME = "openclaw-plugin-telemetry-sent";

/** Build the absolute stamp path under the given cache directory. */
export function stampPath(cacheDir: string): string {
  if (!cacheDir) return "";
  return path.join(cacheDir, STAMP_FILE_NAME);
}
