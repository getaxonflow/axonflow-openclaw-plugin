/**
 * Single audited read site for the `AXONFLOW_USER_TOKEN` setting.
 *
 * WHY this module exists as its own zero-import leaf: least-privilege by
 * construction — exactly one key, one call site, in a module that imports
 * nothing and is imported only for this one named read. Keeping the read
 * isolated here means the token resolver and everything downstream of it
 * contain no direct configuration access at all.
 *
 * The returned value is a credential candidate — callers must sanity-gate and
 * never log it. This function performs the raw read only.
 */
export function userTokenFromEnv(): string | undefined {
  return process.env.AXONFLOW_USER_TOKEN;
}
