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

/**
 * The COMPLETE effective-endpoint decision, shared by `resolveConfig`
 * (governance runtime) and `resolveStatusInputs` (status display):
 *
 *   1. `AXONFLOW_ENDPOINT` env var
 *   2. pluginConfig.endpoint
 *   3. pluginConfig has clientId/clientSecret → SELF_HOSTED_DEFAULT_ENDPOINT
 *      (credentials imply a self-hosted deployment; the runtime targets the
 *      canonical local-agent URL, so status must display the same)
 *   4. nothing provided → COMMUNITY_SAAS_DEFAULT_ENDPOINT
 *
 * Never throws — the status surface must degrade gracefully on partial or
 * inconsistent config (resolveConfig applies its own validation separately).
 */
export function resolveEffectiveEndpoint(
  pluginConfig: Record<string, unknown> | undefined,
): string {
  const cfg = pluginConfig ?? {};
  const userEndpoint = resolveEndpointOverride(cfg["endpoint"]);
  if (userEndpoint !== "") {
    return userEndpoint;
  }
  const clientId =
    typeof cfg["clientId"] === "string" ? (cfg["clientId"] as string).trim() : "";
  const clientSecret =
    typeof cfg["clientSecret"] === "string" ? (cfg["clientSecret"] as string).trim() : "";
  if (clientId !== "" || clientSecret !== "") {
    return SELF_HOSTED_DEFAULT_ENDPOINT;
  }
  return COMMUNITY_SAAS_DEFAULT_ENDPOINT;
}
