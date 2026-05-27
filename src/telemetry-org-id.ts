/**
 * Deployment-organization identifier resolver.
 *
 * Resolves the org_id for the telemetry heartbeat payload. Three sources
 * in precedence order: ORG_ID env var, tenant_id from try-registration.json,
 * or the local-dev sentinel.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { axonflowConfigDir } from "./cache-dir.js";

/**
 * Sentinel emitted on the telemetry wire when no `ORG_ID` env and no
 * registration file are available — the default-config Community-mode
 * developer case.
 */
export const ORG_ID_LOCAL_DEV_SENTINEL = "local-dev-org";

/**
 * Returns the `org_id` value to emit on the next telemetry ping. Three
 * sources in precedence order:
 *   1. `ORG_ID` env var when set (operator's explicit configuration).
 *   2. `tenant_id` from `axonflowConfigDir()/try-registration.json`
 *      (the `cs_<uuid>` Community SaaS tenant identifier — same file
 *      the Community-SaaS bootstrap writes on first registration).
 *   3. `ORG_ID_LOCAL_DEV_SENTINEL`.
 *
 * Reads the registration file at telemetry time (rather than receiving
 * the value via config) to avoid a timing race where the heartbeat
 * fires before the async bootstrap has populated config.
 */
export function telemetryOrgID(): string {
  const fromEnv = process.env.ORG_ID;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const regFile = path.join(axonflowConfigDir(), "try-registration.json");
    if (fs.existsSync(regFile)) {
      const raw = fs.readFileSync(regFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as { tenant_id?: unknown }).tenant_id === "string" &&
        ((parsed as { tenant_id: string }).tenant_id).length > 0
      ) {
        return (parsed as { tenant_id: string }).tenant_id;
      }
    }
  } catch {
    // Best-effort. Fall through to sentinel.
  }
  return ORG_ID_LOCAL_DEV_SENTINEL;
}
