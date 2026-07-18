/**
 * Per-user authorization token resolution — axonflow-enterprise#2945
 * (epic #2919: per-user identity + role on the fleet/MCP-server plane).
 *
 * The platform's fleet plane authenticates the TENANT with the shared Basic
 * credential; a per-user token yields a VALIDATED, non-forgeable
 * {identity, role} for the developer behind the session
 * (platform/agent/mcp_server_handler.go authenticateMCPServerRequest →
 * extractPerUserToken, which reads the `X-User-Token` header). The token is
 * minted by an org admin via the platform mint API
 * (POST /api/v1/admin/organizations/{org_id}/user-tokens, enterprise#2930)
 * and delivered to each developer via managed settings / MDM — the same
 * distribution channel the Claude Code plugin uses (axonflow-claude-plugin#107).
 *
 * Resolution order (canonical, must not change without a CHANGELOG entry):
 *
 *   1. pluginConfig.userToken — the OpenClaw-native config surface, most
 *      specific to this plugin instance.
 *   2. AXONFLOW_USER_TOKEN env var (managed settings / MDM env block).
 *   3. ~/.config/axonflow/user-token.json — {"token": "<minted token>"},
 *      written by the fleet's provisioning tooling. This path is the
 *      CROSS-PLUGIN provisioning contract shared with axonflow-claude-plugin
 *      (scripts/user-token.sh) — deliberately NOT $AXONFLOW_CONFIG_DIR, so a
 *      fleet provisions ONE file that every AxonFlow plugin on the machine
 *      reads. Mode must be 0600 on POSIX (same discipline as
 *      try-registration.json); a file with other permissions is REJECTED
 *      with a warning rather than loaded silently.
 *
 *   Note the deliberate divergence from `licenseToken` (where env wins over
 *   config per ADR-049): for the per-user token the plugin-native config is
 *   the highest-priority source, per the #2945 parity contract.
 *
 * A malformed candidate at a higher-priority source is DROPPED (with a
 * warning that never contains the value) and resolution FALLS THROUGH to the
 * next source — it does not suppress lower-priority sources. This is the
 * axonflow-claude-plugin#108 lesson: a malformed env token that suppresses a
 * valid 0600 file silently downgrades the developer to least-privilege.
 *
 * The token VALUE is a credential: it is never logged, never echoed, and
 * never included in any warning string produced here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { userTokenFromEnv } from "./user-token-env.js";

/** Result of per-user token resolution. */
export interface UserTokenResolution {
  /** Wire-safe token, or undefined when none is configured/usable. */
  token?: string;
  /**
   * Which source the token came from — surfaced in the init canary so a
   * fleet operator can tell config/env/file provisioning apart. Undefined
   * when no token resolved.
   */
  source?: "pluginConfig" | "env" | "file";
  /**
   * Operator-visible diagnostics (malformed candidates dropped, unsafe file
   * permissions). NEVER contain the token value — safe to log verbatim.
   */
  warnings: string[];
}

/**
 * Sanity-gate a candidate token before it goes on the wire. Minted per-user
 * tokens (HS256 Path A and OIDC Path B) are compact JWTs: base64url segments
 * joined by dots — no whitespace, no control bytes, no quotes, no
 * backslashes. A candidate containing any of those is junk (mis-pasted,
 * truncated multi-line, or corrupted), and sending it would be WORSE than
 * sending nothing: the platform fails closed on a presented-but-invalid
 * token (an access attempt, not a legacy caller), turning every governed
 * call into an auth denial. Rejecting locally keeps the developer on the
 * least-privilege path with a clear diagnostic instead.
 *
 * Deliberately does NOT pin the JWT structure (segment count, prefix): the
 * platform owns token-format evolution; this guard only rejects values that
 * can never be a wire-safe credential (no CR/LF header-splitting bytes, no
 * quote/backslash JSON-breaking bytes, nothing outside printable ASCII).
 *
 * The printable-ASCII bound is load-bearing, not cosmetic (R3 round-1 H1):
 * fetch() header values must be ByteStrings, so ANY char above U+00FF (a
 * smart quote or en-dash from a rich-text paste of the minted token) makes
 * fetch throw a TypeError BEFORE the request leaves the process. That error
 * carries no HTTP status and doesn't match governance's auth-error
 * classifier, so tool governance would treat it as a transient network
 * error and FAIL OPEN even under onError:"block" — silently, on every tool
 * call. Rejecting here keeps such a candidate on the drop-with-warning +
 * fall-through path instead.
 */
export function userTokenLooksValid(token: string): boolean {
  if (!token) return false;
  // Every char must be printable ASCII (excludes whitespace, C0 + C1
  // controls, DEL, and everything >= U+0080), minus the JSON/header-breaking
  // double quote and backslash.
  return /^[!-~]+$/.test(token)
    && !token.includes('"')
    && !token.includes("\\");
}

/**
 * Canonical cross-plugin provisioning path: ~/.config/axonflow/user-token.json.
 * Shared with axonflow-claude-plugin — see the module docstring for why this
 * is NOT $AXONFLOW_CONFIG_DIR.
 */
export function userTokenFilePath(homedir: string = os.homedir()): string {
  return path.join(homedir, ".config", "axonflow", "user-token.json");
}

interface ResolveUserTokenOptions {
  /**
   * Override for the AXONFLOW_USER_TOKEN env VALUE (test injection). Pass
   * `""` to simulate an unset variable. Defaults to the `AXONFLOW_USER_TOKEN`
   * environment variable, read via the import-free `userTokenFromEnv()` leaf
   * module. Deliberately a single named value, NOT an env map: this module's
   * output goes on the wire, so it must never hold a reference to the full
   * process environment object (marketplace static analysis flags full-env
   * capture in network-reachable modules, and least-privilege says we only
   * need the one key anyway).
   */
  userTokenEnvValue?: string;
  /** Home dir override (test injection). Defaults to os.homedir(). */
  homedir?: string;
}

function readTokenFile(file: string, warnings: string[]): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined; // Missing file is the normal case — no warning.
  }
  // Same POSIX permission posture as try-registration.json
  // (community-saas-context.ts readRegistrationIfFreshAndSafe): refuse
  // anything other than 0600. Windows has no POSIX mode bits — skip there.
  if (process.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      warnings.push(
        `[AxonFlow] ${file} has unsafe permissions (${mode.toString(8).padStart(3, "0")}); ` +
        `refusing to use. chmod 600 '${file}' to restore per-user authorization.`,
      );
      return undefined;
    }
  }
  let tok = "";
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    tok = typeof parsed["token"] === "string" ? (parsed["token"] as string).trim() : "";
  } catch {
    warnings.push(
      `[AxonFlow] ${file} is not valid JSON; ignoring. Re-provision it from your admin's mint output.`,
    );
    return undefined;
  }
  if (!tok) return undefined;
  if (!userTokenLooksValid(tok)) {
    // Never print the value — it may be a credential with a typo in it.
    warnings.push(
      `[AxonFlow] ${file} contains a malformed per-user token (whitespace/control/quote bytes); ` +
      `ignoring. Re-provision it from your admin's mint output.`,
    );
    return undefined;
  }
  return tok;
}

/**
 * Resolve the per-user token across the three sources. Malformed candidates
 * at a higher-priority source fall through to the next source (never
 * suppress it — the #108 equivalence contract). Returns the wire-safe token
 * plus warnings that are safe to log (no token values, ever).
 */
export function resolveUserToken(
  configValue: unknown,
  opts?: ResolveUserTokenOptions,
): UserTokenResolution {
  const warnings: string[] = [];

  // 1. pluginConfig.userToken
  const cfgToken = typeof configValue === "string" ? configValue.trim() : "";
  if (cfgToken) {
    if (userTokenLooksValid(cfgToken)) {
      return { token: cfgToken, source: "pluginConfig", warnings };
    }
    warnings.push(
      "[AxonFlow] pluginConfig.userToken contains whitespace/control/quote bytes; ignoring. " +
      "Re-provision it from your admin's mint output.",
    );
  }

  // 2. AXONFLOW_USER_TOKEN env var — a single static named read, isolated in
  // the import-free userTokenFromEnv() leaf; never capture or index into an
  // env object (see ResolveUserTokenOptions).
  const rawEnvValue = opts?.userTokenEnvValue ?? userTokenFromEnv();
  const envToken = typeof rawEnvValue === "string" ? rawEnvValue.trim() : "";
  if (envToken) {
    if (userTokenLooksValid(envToken)) {
      return { token: envToken, source: "env", warnings };
    }
    warnings.push(
      "[AxonFlow] AXONFLOW_USER_TOKEN is set but contains whitespace/control/quote bytes; ignoring. " +
      "Re-provision it from your admin's mint output.",
    );
  }

  // 3. 0600 provisioning file
  const fileToken = readTokenFile(userTokenFilePath(opts?.homedir), warnings);
  if (fileToken) {
    return { token: fileToken, source: "file", warnings };
  }

  return { warnings };
}
