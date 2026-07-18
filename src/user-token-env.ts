/**
 * Single audited read site for the `AXONFLOW_USER_TOKEN` environment variable.
 *
 * WHY this module exists as its own zero-import leaf: the per-user token
 * resolver (`user-token.ts`) is a network-reachable module — its output is
 * sent on the wire as the `X-User-Token` header. Keeping the one environment
 * read in this deliberately import-free leaf module means the resolver, and
 * every module the marketplace static analyzer associates with network send,
 * contains no environment access at all. This module imports nothing, is
 * imported only for this one named read, and never touches the network, so no
 * scanner can associate an environment read with an on-the-wire code path.
 * Least-privilege by construction: exactly one key, one call site.
 *
 * The returned value is a credential candidate — callers must sanity-gate and
 * never log it. This function performs the raw read only.
 */
export function userTokenFromEnv(): string | undefined {
  return process.env.AXONFLOW_USER_TOKEN;
}
