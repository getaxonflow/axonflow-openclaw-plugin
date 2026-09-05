/**
 * Configuration for the AxonFlow governance plugin.
 *
 * All configuration is read from the OpenClaw plugin config system
 * (openclaw.plugin.json or runtime config).
 */

import { resolveDeploymentTarget } from "./endpoint-env.js";
import { resolveUserToken } from "./user-token.js";

export interface AxonFlowPluginConfig {
  /**
   * AxonFlow agent gateway endpoint (e.g., "http://localhost:8080").
   *
   * Resolution order (#162, shared with the status surface via
   * src/endpoint-env.ts so the two can never diverge):
   *   1. the `AXONFLOW_ENDPOINT` environment variable
   *   2. pluginConfig.endpoint
   *   3. mode-dependent default (see `resolveConfig`)
   * Empty / whitespace-only values are treated as unset. An env-provided
   * endpoint counts as user-provided for the deployment-mode decision:
   * setting `AXONFLOW_ENDPOINT` selects self-hosted mode, so governed
   * traffic goes to that endpoint and the Community-SaaS auto-registration
   * never runs.
   */
  endpoint: string;

  /** Tenant identity for data isolation. Defaults to "community" for community mode. */
  clientId: string;

  /** License key for evaluation/enterprise features. Empty for community mode. */
  clientSecret: string;

  /**
   * Plugin-claim license token (W4 paid Pro v1 tier, ADR-049).
   *
   * AXON-prefixed Ed25519-signed JWT issued by axonflow-billing on a
   * successful Stripe checkout. When present, the plugin forwards it on
   * every governed HTTP request via the `X-License-Token` header so the
   * agent's PluginClaimMiddleware can validate it and enrich the request
   * context with Pro-tier entitlements (retention, quotas, capabilities).
   *
   * Resolution order (matches the W4 launch spec):
   *   1. the `AXONFLOW_LICENSE_TOKEN` environment variable
   *   2. pluginConfig.licenseToken
   *   3. unset → free tier (no header sent)
   *
   * Empty / whitespace values are treated as unset. The plugin does NOT
   * validate the token client-side — validation is the agent middleware's
   * job. A malformed token sent here will be rejected with 401 by the
   * platform on the first governed request, and the existing onError
   * fail-closed/open path applies.
   */
  licenseToken?: string;

  /**
   * Per-user authorization token forwarded on every governed request via
   * X-User-Token (axonflow-enterprise#2945, epic #2919).
   *
   * The platform's fleet plane authenticates the TENANT with the shared
   * Basic credential; this token yields a VALIDATED, non-forgeable
   * {identity, role} for the developer behind the session, minted by an org
   * admin via the platform mint API (enterprise#2930). With it, role-scoped
   * reads (RBAC-3, enterprise#2922) return the developer's own rows instead
   * of the token-less least-privilege default (zero rows post-#2936), and
   * audit attribution keys on the token's validated email rather than the
   * forgeable `userEmail` label.
   *
   * Resolution order (see src/user-token.ts):
   *   1. pluginConfig.userToken
   *   2. AXONFLOW_USER_TOKEN env var
   *   3. ~/.config/axonflow/user-token.json (0600, cross-plugin
   *      provisioning file shared with axonflow-claude-plugin)
   *
   * A malformed candidate is dropped (never sent — the platform fails
   * closed on a presented-but-invalid token) and resolution falls through
   * to the next source. Unset ⇒ the header is omitted entirely and every
   * request is byte-identical to v2.6.7.
   *
   * The value is a credential: never logged, never echoed, and redacted
   * from every diagnostic this plugin emits.
   */
  userToken?: string;

  /**
   * ADR-065 capability handshake audience (axonflow-enterprise#3763).
   *
   * SET AS `AXONFLOW_PEP_AUDIENCE`. Both names matter: the environment
   * variable is what an operator sets and this field is what a reader of the
   * code finds.
   *
   * UNSET IS THE DEFAULT AND SENDS NO HEADER, leaving the plugin behaving byte
   * for byte as it did before. Opt-in because on an Enterprise platform the
   * transition it gates on the REQUEST path is ALLOW -> DENY: that path cannot
   * yet substitute a masked statement (issue #192), so it declares nothing and
   * the platform refuses rather than allowing the call on the strength of a
   * substitution that path cannot perform. On a Community platform nothing is
   * denied either way; the declaration is recorded and counted so the
   * capability gap is visible to an operator.
   *
   * Same variable name and semantics as every other AxonFlow client's knob.
   */
  pepAudience?: string;

  /**
   * Which source `userToken` resolved from ("pluginConfig" | "env" |
   * "file") — surfaced in the init canary so fleet operators can tell the
   * provisioning channels apart. Set by `resolveConfig`; undefined when no
   * token is configured. Never contains the token value.
   */
  userTokenSource?: "pluginConfig" | "env" | "file";

  /**
   * Diagnostics produced during userToken resolution (malformed candidates
   * dropped, unsafe file permissions). Set by `resolveConfig`; guaranteed
   * to never contain the token value — safe to log verbatim. index.ts
   * surfaces these through the host logger at plugin init.
   */
  userTokenWarnings?: string[];

  /**
   * Per-user identity forwarded on every request via X-User-Email.
   *
   * Required (and only required) when you want user-scoped AxonFlow
   * features to work through this plugin:
   *   - `createOverride` / `revokeOverride` / `listOverrides`
   *     (endpoint requires an authenticated user identity per ADR-044)
   *   - `explainDecision` historical_hit_count scoping
   *   - per-user override enforcement on block paths
   *
   * If unset, block responses still include decision_id + risk_level
   * + policy_matches, but the override lifecycle methods will reject
   * with HTTP 401 and explain's hit-count will aggregate across users.
   *
   * A reasonable default for CLI/local-agent setups is `os.userInfo().username`
   * + the agent hostname; a reasonable default for multi-tenant SaaS
   * deployments is the end-user's authenticated email.
   */
  userEmail?: string;

  /**
   * Tools that require human approval even when AxonFlow allows them.
   * Uses OpenClaw's native approval flow (Telegram/Discord/approve command).
   */
  highRiskTools?: string[];

  /**
   * Tools to govern. If empty, ALL tools are governed.
   * Use this to selectively enable governance on specific tools.
   */
  governedTools?: string[];

  /**
   * Tools to exclude from governance. Takes precedence over governedTools.
   */
  excludedTools?: string[];

  /**
   * Operation type sent to mcp_check_input.
   * Defaults to "execute". Set to "query" for read-only tool setups.
   */
  defaultOperation?: string;

  /**
   * Behavior when AxonFlow is unreachable (network error, timeout).
   * - "block" (default): treat errors as policy blocks (fail-closed)
   * - "allow": allow tool execution to proceed (fail-open)
   *
   * Fail-open prevents AxonFlow outages from breaking all tool execution.
   * Fail-closed is safer but can cascade AxonFlow failures to the agent.
   */
  onError?: "block" | "allow";

  /**
   * Timeout for AxonFlow HTTP calls in milliseconds.
   * Applies to policy checks, output scans, audit writes, and health checks.
   * Defaults to 8000ms.
   */
  requestTimeoutMs?: number;

  /**
   * Resolved deployment mode (set by `resolveConfig`):
   *   - "community-saas": user provided no explicit endpoint/clientId/clientSecret;
   *     plugin will register against try.getaxonflow.com on first run.
   *   - "self-hosted": user provided at least one of endpoint/clientId/clientSecret;
   *     plugin uses those values verbatim (no Community-SaaS bootstrap).
   *
   * Surfaced on the config so callers can emit the mode-clarity canary
   * "[AxonFlow] Connected to AxonFlow at <URL> (mode=<X>)" and so the
   * Gate 4 mode-clarity test can assert it.
   */
  mode: "community-saas" | "self-hosted";
}

/**
 * Validate plugin config and return defaults.
 *
 * Resolution order (ADR-048):
 *   1. If the user provided ANY of endpoint, clientId, clientSecret → mode is
 *      "self-hosted". Defaults are filled in: endpoint defaults to localhost,
 *      clientId defaults to "community", clientSecret stays empty (community
 *      mode). The user's explicit values are honoured untouched.
 *   2. If the user provided NONE → mode is "community-saas". Endpoint
 *      defaults to https://try.getaxonflow.com. clientId/clientSecret stay
 *      EMPTY here — the caller (registerAxonFlowGovernance) is expected to
 *      bootstrap the registration via community-saas-bootstrap.ts and
 *      override clientId/clientSecret on the resulting client.
 *
 * "User provided an endpoint" covers BOTH channels (#162): the
 * `AXONFLOW_ENDPOINT` environment variable (which wins) and
 * pluginConfig.endpoint — resolved by the shared `resolveEndpointOverride`
 * helper that the status surface also calls. An operator who configures
 * the endpoint only via the environment therefore gets self-hosted mode:
 * governed traffic targets their endpoint and no Community-SaaS
 * auto-registration runs.
 */
export function resolveConfig(
  raw: Record<string, unknown> | undefined,
): AxonFlowPluginConfig {
  const safe = raw ?? {};

  const rawClientId = typeof safe["clientId"] === "string" ? (safe["clientId"] as string).trim() : "";
  const rawClientSecret = typeof safe["clientSecret"] === "string" ? (safe["clientSecret"] as string).trim() : "";

  // Reject clientSecret without clientId regardless of mode — licensed
  // setups must specify the tenant identity.
  if (!rawClientId && rawClientSecret) {
    throw new Error(
      "AxonFlow plugin: 'clientId' is required when 'clientSecret' is set. " +
      "Set clientId to your tenant identity (e.g., your deployment's AXONFLOW_CLIENT_ID)."
    );
  }

  // Endpoint, mode AND tenant identity all come from the SAME shared
  // decision the status surfaces use (env > pluginConfig > credentials-
  // implied local default > Community-SaaS default), so display and runtime
  // cannot disagree (#162, widened to identity + mode in #167).
  const target = resolveDeploymentTarget(safe);
  const { endpoint, mode } = target;
  // In community-saas mode the bootstrap fills the credentials in. We
  // deliberately leave them empty here so a misconfigured caller that skips
  // the bootstrap step gets a clear 401 from the agent rather than a
  // half-credentialled request.
  const clientId = target.clientId;
  const clientSecret = mode === "self-hosted" ? rawClientSecret : "";

  // License token resolution — env wins over pluginConfig per ADR-049 + the
  // W4 spec, matching how every other AxonFlow surface resolves credentials
  // (env > config > unset). Tolerates "AXON-" prefix or any other shape;
  // validation lives server-side in the agent's PluginClaimMiddleware.
  const envToken = typeof process.env["AXONFLOW_LICENSE_TOKEN"] === "string"
    ? (process.env["AXONFLOW_LICENSE_TOKEN"] as string).trim()
    : "";
  const cfgToken = typeof safe["licenseToken"] === "string"
    ? (safe["licenseToken"] as string).trim()
    : "";
  const licenseToken = envToken || cfgToken || undefined;

  // Per-user token resolution (#2945) — pluginConfig > env > 0600 file,
  // with malformed-candidate fall-through. See src/user-token.ts for the
  // full contract. Warnings are attached to the config so index.ts can
  // surface them through the host logger (this module has no logger).
  const userTokenResolution = resolveUserToken(safe["userToken"]);

  // ADR-065 capability handshake audience. env > pluginConfig > unset, the same
  // precedence every other credential-shaped value on this surface uses.
  // Unset presents no header and changes nothing.
  const envAudience = typeof process.env["AXONFLOW_PEP_AUDIENCE"] === "string"
    ? (process.env["AXONFLOW_PEP_AUDIENCE"] as string).trim()
    : "";
  const cfgAudience = typeof safe["pepAudience"] === "string"
    ? (safe["pepAudience"] as string).trim()
    : "";
  const pepAudience = envAudience || cfgAudience || undefined;

  return {
    endpoint,
    clientId,
    clientSecret,
    mode,
    licenseToken,
    pepAudience,
    userToken: userTokenResolution.token,
    userTokenSource: userTokenResolution.source,
    userTokenWarnings: userTokenResolution.warnings.length > 0
      ? userTokenResolution.warnings
      : undefined,
    userEmail:
      typeof safe["userEmail"] === "string" && (safe["userEmail"] as string).trim()
        ? (safe["userEmail"] as string).trim()
        : undefined,
    highRiskTools: Array.isArray(safe["highRiskTools"])
      ? (safe["highRiskTools"] as string[])
      : [],
    governedTools: Array.isArray(safe["governedTools"])
      ? (safe["governedTools"] as string[])
      : [],
    excludedTools: Array.isArray(safe["excludedTools"])
      ? (safe["excludedTools"] as string[])
      : [],
    defaultOperation:
      typeof safe["defaultOperation"] === "string"
        ? (safe["defaultOperation"] as string)
        : "execute",
    onError:
      safe["onError"] === "allow" ? "allow" : "block",
    requestTimeoutMs:
      typeof safe["requestTimeoutMs"] === "number" &&
      Number.isFinite(safe["requestTimeoutMs"]) &&
      (safe["requestTimeoutMs"] as number) > 0
        ? (safe["requestTimeoutMs"] as number)
        : 8000,
  };
}

/** Check if a tool should be governed based on config. */
export function shouldGovernTool(
  toolName: string,
  config: AxonFlowPluginConfig,
): boolean {
  // Excluded tools take precedence
  if (config.excludedTools && config.excludedTools.includes(toolName)) {
    return false;
  }
  // If governedTools is specified, only those are governed
  if (config.governedTools && config.governedTools.length > 0) {
    return config.governedTools.includes(toolName);
  }
  // Default: govern all tools
  return true;
}
