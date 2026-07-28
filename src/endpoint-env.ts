/**
 * Single audited read site for the `AXONFLOW_ENDPOINT` setting, plus the
 * ONE shared endpoint-override resolution that both the governance runtime
 * (src/config.ts → AxonFlowClient) and the status surface (src/status.ts)
 * call.
 *
 * WHY a shared helper (#162): through v2.8.3 the endpoint was resolved
 * independently in two places — status.ts honoured the documented
 * `env > pluginConfig > default` precedence while the governance runtime
 * read `pluginConfig.endpoint` only. The two surfaces drifted: an operator
 * who set `AXONFLOW_ENDPOINT` for a self-hosted deployment saw `status`
 * confirm their endpoint while governed traffic (tool arguments, outbound
 * message bodies, audit content) kept flowing to the Community SaaS
 * default. Routing both surfaces through this single function makes that
 * divergence structurally impossible: what status displays IS what the
 * runtime uses.
 *
 * #167 widened that guarantee from the endpoint to the whole deployment
 * decision (endpoint + mode + tenant identity) via `resolveDeploymentTarget`,
 * after the drift reappeared through the other channel: the standalone status
 * CLI could not see `pluginConfig` at all, so a self-hoster who configured
 * `pluginConfig.endpoint` was told their traffic went to the Community SaaS.
 *
 * WHY the read is a zero-import leaf with one static named read: same
 * least-privilege-by-construction rule as src/user-token-env.ts — exactly
 * one key, one call site, no env-object capture, no dynamic indexing.
 * The endpoint is not a credential, but keeping every environment read
 * static and named keeps the configuration surface auditable at a glance.
 */

/** Raw read of the `AXONFLOW_ENDPOINT` environment variable. */
export function endpointFromEnv(): string | undefined {
  return process.env.AXONFLOW_ENDPOINT;
}

/**
 * Resolve the USER-PROVIDED endpoint with the documented precedence
 * (openclaw.plugin.json `envVars.AXONFLOW_ENDPOINT`):
 *
 *   1. `AXONFLOW_ENDPOINT` environment variable
 *   2. `pluginConfig.endpoint`
 *
 * Values are trimmed; empty / whitespace-only / non-string candidates are
 * treated as unset and resolution falls through to the next source.
 *
 * Returns `""` when the user provided neither, so each caller applies its
 * own default — and, in `resolveConfig`, the deployment-mode decision: a
 * non-empty return value counts as a user-provided endpoint, which selects
 * self-hosted mode (no Community-SaaS auto-registration).
 */
export function resolveEndpointOverride(pluginConfigEndpoint: unknown): string {
  const envRaw = endpointFromEnv();
  const envEndpoint = typeof envRaw === "string" ? envRaw.trim() : "";
  if (envEndpoint !== "") {
    return envEndpoint;
  }
  return typeof pluginConfigEndpoint === "string"
    ? pluginConfigEndpoint.trim()
    : "";
}

/** Endpoint used when the user provided nothing at all (Community SaaS). */
export const COMMUNITY_SAAS_DEFAULT_ENDPOINT = "https://try.getaxonflow.com";

/**
 * Endpoint used when the user provided credentials but no endpoint —
 * the canonical local-agent URL. Matches the bash plugins' resolution rule.
 */
export const SELF_HOSTED_DEFAULT_ENDPOINT = "http://localhost:8080";

/** Tenant identity used in self-hosted mode when the user named none. */
export const SELF_HOSTED_DEFAULT_CLIENT_ID = "community";

/**
 * Everything the plugin decides about WHICH AxonFlow it talks to and
 * WHO it talks as, derived from the user's configuration alone.
 */
export interface DeploymentTarget {
  /** Endpoint every governed request targets. Never empty. */
  endpoint: string;
  /**
   * "self-hosted" when the user provided any of endpoint / clientId /
   * clientSecret (through either channel); "community-saas" otherwise.
   */
  mode: "community-saas" | "self-hosted";
  /**
   * Tenant identity the runtime authenticates as. `SELF_HOSTED_DEFAULT_CLIENT_ID`
   * when the user named an endpoint but no clientId. Empty in community-saas
   * mode, where the Community-SaaS bootstrap supplies the identity at runtime
   * and persists it in `try-registration.json`.
   */
  clientId: string;
  /**
   * Where {@link clientId} came from. Carried here rather than re-derived by
   * consumers so display surfaces can tell an operator who explicitly set
   * `clientId: "community"` apart from one who set no clientId at all — the
   * resolved value is identical, the advice is not.
   */
  clientIdSource: "plugin-config" | "self-hosted-default" | "community-saas-bootstrap";
}

/**
 * The COMPLETE deployment decision — endpoint, mode, and tenant identity —
 * shared by `resolveConfig` (governance runtime), `resolveStatusInputs`
 * (status CLI + `axonflow_get_tenant_id`), and nothing else:
 *
 *   1. `AXONFLOW_ENDPOINT` env var                     → self-hosted
 *   2. pluginConfig.endpoint                           → self-hosted
 *   3. pluginConfig has clientId/clientSecret          → self-hosted at
 *      SELF_HOSTED_DEFAULT_ENDPOINT (credentials imply a self-hosted
 *      deployment; the runtime targets the canonical local-agent URL, so
 *      every display surface must say the same)
 *   4. nothing provided → community-saas at COMMUNITY_SAAS_DEFAULT_ENDPOINT
 *
 * This is the single function permitted to make that decision. #167 was the
 * second drift incident in the same family: the status CLI is a standalone
 * bin with no pluginConfig context, so it resolved from the environment
 * alone and told self-hosted operators their traffic went to the Community
 * SaaS while the runtime governed correctly against their own stack. The
 * fix is to feed this one function the pluginConfig the CLI could not
 * otherwise see (src/plugin-runtime-state.ts) — never to add a second
 * resolution path.
 *
 * Never throws — the status surface must degrade gracefully on partial or
 * inconsistent config (resolveConfig applies its own validation separately).
 */
export function resolveDeploymentTarget(
  pluginConfig: Record<string, unknown> | undefined,
): DeploymentTarget {
  const cfg = pluginConfig ?? {};
  const userEndpoint = resolveEndpointOverride(cfg["endpoint"]);
  const clientId =
    typeof cfg["clientId"] === "string" ? (cfg["clientId"] as string).trim() : "";
  const clientSecret =
    typeof cfg["clientSecret"] === "string" ? (cfg["clientSecret"] as string).trim() : "";

  if (userEndpoint !== "" || clientId !== "" || clientSecret !== "") {
    return {
      endpoint: userEndpoint !== "" ? userEndpoint : SELF_HOSTED_DEFAULT_ENDPOINT,
      mode: "self-hosted",
      clientId: clientId !== "" ? clientId : SELF_HOSTED_DEFAULT_CLIENT_ID,
      clientIdSource: clientId !== "" ? "plugin-config" : "self-hosted-default",
    };
  }
  return {
    endpoint: COMMUNITY_SAAS_DEFAULT_ENDPOINT,
    mode: "community-saas",
    clientId: "",
    clientIdSource: "community-saas-bootstrap",
  };
}

/**
 * Endpoint half of {@link resolveDeploymentTarget}, kept as a named export
 * for callers that only need the URL. Delegates rather than re-deriving so
 * there is exactly one implementation of the precedence rules.
 */
export function resolveEffectiveEndpoint(
  pluginConfig: Record<string, unknown> | undefined,
): string {
  return resolveDeploymentTarget(pluginConfig).endpoint;
}

/**
 * Community-SaaS bootstrap endpoint substitution, shared by the bootstrap
 * itself (`src/community-saas-bootstrap.ts`) and the status surface
 * (`src/status.ts`).
 *
 * `POST /api/v1/register` may hand back the endpoint the tenant should use,
 * which the runtime then adopts in place of the resolved default. The status
 * surface has to apply the identical substitution or it reports the default
 * while governed traffic goes somewhere else — the #167 failure mode one
 * layer down. Empty / whitespace-only / non-string registered values are
 * treated as "the server named no endpoint" and the fallback stands.
 */
export function resolveRegisteredEndpoint(
  registeredEndpoint: unknown,
  fallback: string,
): string {
  const registered =
    typeof registeredEndpoint === "string" ? registeredEndpoint.trim() : "";
  return registered !== "" ? registered : fallback;
}
