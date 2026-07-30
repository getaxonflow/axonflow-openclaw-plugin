/**
 * Plugin version — single source of truth.
 *
 * Kept in its own module so non-index consumers (axonflow-client.ts, etc.)
 * can import it without creating a circular dependency through index.ts.
 *
 * Update this string before each release. The gate is a unit test —
 * `tests/telemetry.test.ts` → "VERSION constant matches package.json version" —
 * which runs on every PR. `publish.yml` does NOT check it: on tag push it reads
 * the version from the ref and only rewrites package.json, so a forgotten bump
 * here would ship a release that reports the previous version in
 * `X-Axonflow-Client` and to the plugin-version check.
 */

export const VERSION = "2.8.5";
