/**
 * Plugin version — single source of truth.
 *
 * Kept in its own module so non-index consumers (axonflow-client.ts, etc.)
 * can import it without creating a circular dependency through index.ts.
 *
 * Update this string before each release; CI release pipeline asserts it
 * matches the package.json version on tag.
 */

export const VERSION = "2.6.1";
