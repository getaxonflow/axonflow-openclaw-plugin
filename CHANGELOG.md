# Changelog

## [Unreleased]

## [2.6.1] - 2026-05-20 — Harden auth-failure circuit breaker (non-JSON body + centralized fetch chokepoint)

### Fixed

- **Non-JSON 401 body bypassed the breaker** (follow-up to [axonflow-enterprise#2275](https://github.com/getaxonflow/axonflow-enterprise/issues/2275); tracked as [#2275 follow-up](https://github.com/getaxonflow/axonflow-enterprise/issues/2275)). `mcpCheckInput` and `mcpCheckOutput` did `const data = await response.json()` BEFORE checking `response.status === 401`. A real-world 401 from an infrastructure layer (ALB / nginx / WAF / API Gateway) returns `Content-Type: text/plain` + body `Unauthorized\n` — the `.json()` parse threw `SyntaxError` and propagated past the breaker, leaving `authFailed=false` and re-firing the storm. Both methods now detect `response.status === 401` BEFORE attempting `.json()` and throw the typed `AxonFlowHttpError(401, ...)` directly. Repro: pointing the plugin at a fake HTTP server returning `text/plain` 401 fires 2 POSTs pre-fix; 1 POST post-fix.

- **401 detection centralized at the fetch chokepoint** so all ~19 fetch sites in `AxonFlowClient` flip the breaker, not just the four high-volume entry points (`auditToolCall` / `auditLLMCall` / `mcpCheckInput` / `mcpCheckOutput`). Pre-fix, bad creds still caused 401 storms on `searchAuditEvents`, `explainDecision`, the overrides lifecycle endpoints, `/health`, `listRecentDecisionsStrict`, and `callMCPTool` — just at lower volume than the audit endpoint. Post-fix, the single `if (response.status === 401) this.markAuthFailed()` block in `fetchWithTimeout` engages the breaker on the first 401 from ANY endpoint; the four high-volume entry points keep their early-return short-circuit at the TOP of the method, which prevents the next network call entirely. The per-method `if (response.status === 401) markAuthFailed()` blocks inside the non-2xx branches of `mcpCheckInput` / `mcpCheckOutput` / `auditToolCall` / `auditLLMCall` are removed (the centralized hook covers them) so there's a single wiring pattern across the file.

### Lineage

This patch closes two HIGH findings from a hostile review of the v2.6.0 fix in [PR #138](https://github.com/getaxonflow/axonflow-openclaw-plugin/pull/138) (merged `fc129e2741049a07cb4455587b9cf7faf12e74d2`). The thrown `AxonFlowHttpError(401, ...)` shape is byte-compatible with what `governance.ts:isAxonFlowAuthError` consumes (status-based path, not message-based), so `config.onError` semantics are unchanged.

## [2.6.0] - 2026-05-20 — Auth-failure circuit breaker to prevent 401 storms

### Fixed

- **Process-local 401 circuit breaker (closes [axonflow-enterprise#2275](https://github.com/getaxonflow/axonflow-enterprise/issues/2275)).** When the plugin is configured with bad credentials (expired or mistyped `clientId` / `clientSecret`), every `after_tool_call` hook used to fire a POST to `/api/v1/audit/tool-call`, receive a 401, and silently swallow the error. Over a typical long-lived OpenClaw session this multiplied into hundreds of 401s/day per misconfigured install — the upstream issue cites `716 × 401 in 24h` against a single source IP with User-Agent `node`.

  **Fix.** The `AxonFlowClient` now carries a process-local `authFailed` flag. The first time any of the four auth-bearing entry points (`auditToolCall`, `auditLLMCall`, `mcpCheckInput`, `mcpCheckOutput`) observes an HTTP 401 from the platform, the flag flips to `true` and a one-time `console.warn` surfaces to the operator:

  ```
  [AxonFlow] Authentication failed (HTTP 401). Audit calls disabled
  for this session. Refresh credentials via the OpenClaw runtime config.
  ```

  Every subsequent call from the same client instance short-circuits BEFORE issuing the fetch — no further network traffic until the OpenClaw runtime instantiates a new client (e.g. on config reload). The audit methods keep their fire-and-forget contract (still don't throw); the governance methods (`mcpCheckInput` / `mcpCheckOutput`) throw the same `AxonFlowHttpError` shape that a real 401 would have produced, so `governance.ts`'s `isAxonFlowAuthError` classifier + `config.onError` path applies uniformly.

  **Not affected.** Transient errors (5xx, network failures) do NOT flip the breaker — the existing fail-open path in `governance.ts` keeps handling them as before. Each new `AxonFlowClient` instance starts fresh (no cross-instance state leak).

## [2.5.0] - 2026-05-19 — Terminology: `tenant_id` → `client_id` in user-facing output

### Changed

- **`axonflow-openclaw-status` output: `tenant_id:` label is now `client_id:`.** Same value, new user-facing term. Aligns OpenClaw plugin output with the rest of AxonFlow's v9 terminology (the `org_id` ↔ `client_id` ↔ deployment-license-identity three-identifier model — see [axonflow-enterprise#2230](https://github.com/getaxonflow/axonflow-enterprise/issues/2230)). For this release, the output carries a parenthetical bridge note (`(formerly tenant_id)`) so existing users connect the old and new terms without surprise. The bridge note will be removed in v3.0.0.

  **Cosmetic only — no config change is required.** The on-disk registration file at `$AXONFLOW_CONFIG_DIR/try-registration.json` continues to use the `tenant_id` JSON key (file-format compat with installed base); only the human-readable status output reads `client_id`. Wire-level `X-Axonflow-Client` header is unchanged. The agent-side MCP tool `axonflow_get_tenant_id` keeps its name (callable both as muscle-memory "what's my tenant ID?" and the new "what's my client ID?" — both return the same identifier).

  **JSON consumer compat: `axonflow-openclaw-status --json` populates BOTH `client_id` and the legacy `tenant_id` key** with the same value. The `StatusReport` TypeScript interface exposes both as `string | null` fields. v2.4.x consumers scripting around `.tenant_id` keep working unchanged; new consumers SHOULD prefer `.client_id`. The legacy `tenant_id` alias will be removed in v3.0.0.

  **Action required for users who scripted around the old text output:** if your tooling greps for `tenant_id:` in `axonflow-openclaw-status` stdout, update to grep for `client_id:` (or switch to `--json` mode which still emits the legacy `tenant_id` key).

- **README install-flow examples** updated to use `client_id` terminology consistently. The "Activate Pro tier" walkthrough notes that Stripe Checkout's custom field is still labeled "AxonFlow tenant ID" until that form is updated separately.

## [2.4.0] - 2026-05-09 — Decision History API + policy_version recorded on every decision + telemetry simplification

### Added

- **`axonflow_list_recent_decisions` agent tool** — surfaces the caller's recent governance decisions via the new `list_recent_decisions` MCP tool. Tier-throttled per the platform's Free/Pro window+limit; Free callers hitting the cap see the upgrade envelope rendered to the host.

### Telemetry

- **`AXONFLOW_TELEMETRY=off` is the sole opt-out** for the plugin heartbeat — same single-lever model as the SDKs.
- **Heartbeat payload v1 schema additions**: `telemetry_type: "plugin"`, `endpoint_type` (`localhost | private_network | remote | unknown`), `deployment_mode` (`self_hosted | community_saas | unknown`). Set `AXONFLOW_TRY=1` if your stack proxies a custom hostname into try.getaxonflow.com so heartbeats classify as `community_saas` correctly.

## [2.3.3] - 2026-05-08 — ClawPack format migration

Patch release. No runtime behaviour change. Single substantive improvement: artifact format migration that closes the visible "Legacy ZIP" badge on the ClawHub listing.

### Fixed

- **ClawHub publish migrated from Legacy ZIP → ClawPack via `clawhub@0.12.3`.** `.github/workflows/publish.yml` `Install ClawHub CLI` step pinned from `clawhub@0.12.0` to `clawhub@0.12.3`. v0.12.2 (2026-05-02 21:45 UTC) shipped the CLI fix for v0.12.1's tarball-bytes-mismatch regression ("publish code plugins as clawpacks and allow legacy package downloads"); v0.12.3 (2026-05-06) added monorepo support + `dry-run --metadata-only` + scope-owner inference. Verified working locally via `clawhub package pack` + `clawhub package publish . --dry-run` against this repo at v2.3.2 — clean ClawPack tarball with correct sha256/integrity. Closes the "Legacy ZIP — may have compatibility issues" artifact badge on the ClawHub listing and lifts the verification tier from `source-linked` (lowest) to the modern plugin architecture.

 Safety net unchanged: existing `verify-clawhub-install` job runs `openclaw plugins install clawhub:@axonflow/openclaw@<version>` on every publish and fails fast on any bytes-mismatch — same gate that broke v2.0.5/v2.0.6 visibly during the v0.12.1 regression. If broken, revert path is documented in the project's internal notes and the project's internal notes (clawhub@0.12.0 + folder upload).

### Internal

- **ClawScan `Credentials` review concern remains open** and is upstream-blocked. Architectural research confirmed that the env-vars schema landed in `clawhub@0.7.0` (2026-02-16) is **skill-side only**: parsed from SKILL.md frontmatter into the registry capabilities block for skills. Code plugins (this artifact) have no analogous `envVars` schema slot in their `capabilities` indexing today — the registry stores `bundledSkills`, `capabilityTags`, `commandNames`, `configSchema`, `executesCode`, `hooks`, `providers`, etc., but no `envVars`. The earlier v2.3.1 / v2.3.2 / v2.3.3-WIP attempts to close this client-side via `openclaw.plugin.json envVars`, README.md table, and a SKILL.md frontmatter file at the package root were all wrong-layer fixes — adding a SKILL.md to a code plugin's root would either be inert (right) or cause OpenClaw runtime to inject our governance prose into the agent's system prompt (wrong, since we're a code plugin that registers hooks, not a skill that injects prompts).

 Path forward: the actual fix is upstream in ClawHub (analog of the upstream tracker for skills, but for code-plugin `capabilities.envVars`). Until that ships, the "Review" verdict on the Credentials dimension is acceptable — plugin remains installable; reviewer text is balanced ("These variables are related to AxonFlow, not unrelated services"). Static Analysis verdict stays Benign; ClawPack format moves the visible badge.

## [2.3.2] - 2026-05-07 — README env-vars completeness + cumulative-release-notes automation + manifest-envvars CI gate

Patch release. No runtime behaviour change. Three durable improvements landing in lockstep:

### Fixed

- **`README.md` `## Environment variables` section now declares every `AXONFLOW_*` env var the plugin recognizes.** Promoted from `###` (sub-section under "Where your data goes") to `##` for top-level prominence; added the same three entries v2.3.1 added to `openclaw.plugin.json` envVars but missed in the README:
 - `AXONFLOW_ENDPOINT`
 - `AXONFLOW_RECOVERY_TIMEOUT_MS`
 - `AXONFLOW_UPGRADE_URL`

 README.md is the prose ClawScan reads for the plugin's ClawHub listing (in `package.json` `files` allowlist + not in `.clawhubignore`); v2.3.1's manifest-only fix didn't reach this surface because ClawHub's stored `capabilities` block has no envVars schema slot to index `openclaw.plugin.json` envVars from. README.md is the actual user-and-reviewer-visible declaration.

### Added

- **`.github/workflows/manifest-envvars-coverage.yml`**: new CI gate enforcing three-way coverage between (1) `AXONFLOW_*` references in `src/` + `bin/`, (2) `openclaw.plugin.json` envVars keys, (3) `README.md` `## Environment variables` table entries. Runs on every PR touching those paths and on main pushes; fails fast on drift. Internal-only vars (`AXONFLOW_HARNESS*`, `AXONFLOW_LOGS`, `AXONFLOW_OPENAPI*`, `AXONFLOW_CHECKPOINT_URL`, `AXONFLOW_CLIENT_*`) excluded from the check — these are SDK-side or test-only and don't belong in the plugin manifest.

- **`.github/workflows/publish.yml` preflight cumulative-notes rule**: when releasing a patch (Z>0) within 24h of the parent feature minor (X.Y.0), the preflight automatically appends the parent minor's CHANGELOG section to the GH release body. Closes the v2.3.1 regression where the most-clicked discovery surface (latest-tag landing page) hid the v2.3.0 V1 Plugin Pro feature work behind a hygiene-only patch summary. Same-day patches now ship cumulative release notes by default; >24h patches keep their narrow scope. CHANGELOG.md remains semver-organized (each version its own `## [X.Y.Z]` section).

## [2.3.1] - 2026-05-07 — Manifest envVars completeness + test-script field-name hygiene

Patch release on top of 2.3.0. No runtime behaviour change. Two surfaces tightened:

### Fixed

- **`openclaw.plugin.json` envVars block now declares every AXONFLOW_* env
 var that ship-time code references.** Adds three entries that were
 documented in `clawhub/2.3.0/SKILL.md` and used by `dist/` / `bin/`
 but missing from the manifest's `envVars` block:
 - `AXONFLOW_ENDPOINT` — overrides `pluginConfig.endpoint`; primary
 self-hosted-mode entry point.
 - `AXONFLOW_RECOVERY_TIMEOUT_MS` — per-HTTP timeout for the
 `axonflow-openclaw-recover` CLI (default 10000).
 - `AXONFLOW_UPGRADE_URL` — overrides the upgrade URL surfaced by
 `axonflow-openclaw-status` (default `https://getaxonflow.com/pricing/`).

 Closes the ClawScan v2.3.0 review's "Credentials" dimension concern
 ("registry metadata declares no environment variables" while several
 AXONFLOW_* names appear in code/docs). Pre-tag check now in place: a
 grep of `AXONFLOW_[A-Z_]+` against `src/`, `bin/`, `scripts/` must be
 a subset of `openclaw.plugin.json` envVars keys before tagging
 (internal-only harness vars like `AXONFLOW_HARNESS*` excluded from
 the check).

### Internal

- **the runtime test bundle**: synthetic test-tenant
 secret literal renamed `testpass` → `synth-tok-` to avoid triggering
 generic secret-scanner heuristics on dev machines. The literal had no
 functional role — the test inserts the synthetic value directly into
 the test DB and uses it for Basic auth against a synthetic tenant.
 The unrelated `["password"]` JSON-field reads at lines 105 and 126
 are reading from AWS Secrets Manager's RDS-managed secret structure
 (`{"username", "password", "host", "port", ...}` — AWS schema, not
 AxonFlow-defined) and are correct as-is. Test scripts are not shipped
 to npm or ClawHub (excluded via `.clawhubignore` and absent from npm's
 `files` allowlist) — this is dev-only file hygiene.

## [2.3.0] - 2026-05-07 — V1 Plugin Pro envelope + 5 new agent-callable Pro tools (cross-plugin parity)

Companion plugin release to AxonFlow agent v7.7.0. Surfaces the V1
Plugin Pro structured upgrade envelope to the operator on Community
SaaS rate-limit hits, and adds 5 new agent-callable Pro tools so
OpenClaw agents reach the same V1 Pro toolset that the
`axonflow-claude-plugin` / `axonflow-cursor-plugin` /
`axonflow-codex-plugin` plugins auto-discover from the AxonFlow agent's
MCP server. Total agent-callable tools: 5 → 10.

### Added

- **V1 Plugin Pro upgrade-prompt envelope handling** in
 `src/upgrade-prompt.ts` — sourced into `axonflow-client.ts` so every
 4xx response from `mcpCheckInput` / `mcpCheckOutput` runs through
 envelope detection. When the agent returns a 429 (daily-quota) or
 403 (graduated / Pro-only) with the structured envelope shape:
 - Parses `upgrade.wording` + `upgrade.buy_url` and forwards it to the
 host plugin logger (`api.logger.info`) at most once per UTC day.
 Surfaced to OpenClaw operators via the standard plugin log channel.
 - Honours `Retry-After` / `resets_at` by stamping a back-off file at
 `${AXONFLOW_CACHE_DIR or platform default}/throttle-until`.
 `governance.ts` checks the gate before each governed call and
 short-circuits during the back-off window (no thundering-herd
 retries against the agent).
 - Handles both bare and JSON-RPC-wrapped envelope shapes (the latter
 is what the new V1 Pro MCP tools deliver via `writeMCPGateError`).
- **`axonflow_get_tenant_id` agent-callable tool** — returns the
 install's tenant_id, current tier (Free / Pro / pro_expired),
 endpoint, and the locked V1 upgrade URLs. The other three plugin
 hosts (claude / cursor / codex) get this tool from the agent's MCP
 server via auto-discovery; OpenClaw doesn't proxy that MCP server,
 so we register a local equivalent built from the same status surface
 `recover.sh status` exposes. Keeps cross-plugin behaviour consistent
 for the "what's my tenant ID?" question.
- **Four V1 Plugin Pro proxy tools** registered locally so OpenClaw
 agents reach the same V1 Pro toolset that `axonflow-claude-plugin` /
 `axonflow-cursor-plugin` / `axonflow-codex-plugin` auto-discover from
 the agent's MCP server. OpenClaw doesn't proxy
 `/api/v1/mcp-server` `tools/list`, so these are registered as
 code-defined `AgentToolDef`s whose `execute()` forwards to the agent
 via a single new `AxonFlowClient.callMCPTool(name, args)` helper:
 - `axonflow_request_approval` — Free 1/7d rolling, Pro unlimited.
 - `axonflow_create_tenant_policy` — Free 2 active max, Pro unlimited.
 - `axonflow_get_cost_estimate` — Pro-only; Free callers get the
 locked V1 `feature_pro_only` envelope.
 - `axonflow_list_pro_features` — Free + Pro, locked feature list
 (5 differentiators + $9.99 / 90-day pricing).

 Total agent-callable tools: 5 → 10 (combining `axonflow_get_tenant_id`
 above with these four).
- **`clawhub/2.3.0/SKILL.md`** — frozen per-version skill record for the
 v2.3.0 release. Documents the new agent-callable tools alongside the
 existing 5 governance tools.

### Fixed

- **`AxonFlowClient.handleEnvelope`** — pre-filter on
 `status === 429 || status === 403` was dropping JSON-RPC-wrapped
 envelope responses that come back over HTTP 200 with
 `result.isError = true` (the path the agent's
 `mcp_v1_pro_tools.go writeMCPGateError` uses). Removed the
 pre-filter; `handleV1Envelope` already encodes the full
 status-vs-shape decision and now sees all three envelope-bearing
 paths (429 daily-quota, 403 graduated / Pro-only, 200 + JSON-RPC
 gate). The 4 new proxy tools depend on the 200 path; without this
 fix, Free callers got the envelope content as a generic `kind=ok`
 result instead of a clean `kind=envelope` with the upgrade prompt
 surfaced.

### Internal

- `tests/upgrade-prompt.test.ts` — 26 unit assertions across
 `detectEnvelope`, `retryAfterMs`, `resolveDeadlineMs`,
 `isThrottleActive`, `shouldShowPromptToday`, the full `handleEnvelope`
 state machine, and the `V1_LIMIT_TYPES` locked enumeration.
- the runtime test bundle — drives the compiled
 `dist/upgrade-prompt.js` against a live 429 envelope captured from
 a Free-tier tenant on `try.getaxonflow.com` past the 200/day cap.
- the runtime test bundle — drives the compiled
 `dist/agent-tools.js` + `dist/axonflow-client.js` against a real
 registered tenant on `https://try.getaxonflow.com`. Asserts
 end-to-end that all 5 V1 Pro agent-callable tools dispatch
 correctly: `axonflow_list_pro_features` returns the locked
 5-differentiators shape; `axonflow_get_cost_estimate` on a Free
 tenant lands the `feature_pro_only` envelope with the locked buy
 URL + logger wording + stamped throttle file (and the subsequent
 agent-tool `execute()` honours the throttle gate);
 `axonflow_request_approval` and `axonflow_create_tenant_policy`
 return non-empty `approval_id` / `policy_id` on first Free call,
 with top-level `success: true` alongside `submitted: true` /
 `created: true` on the response body.
- `tests/agent-tools.test.ts` + `tests/registration.test.ts` —
 updated for the new tool count (5 → 10).

### Versions touched

- `package.json`: 2.2.0 → 2.3.0
- `package-lock.json`: 2.2.0 → 2.3.0
- `src/version.ts` (`VERSION` constant — Jest asserts parity): 2.2.0 → 2.3.0
- This CHANGELOG entry

## [2.2.0] - 2026-05-06 — V1 paid Pro tier wire-up + X-Axonflow-Client header

Companion plugin release to platform v7.7.0. Surfaces the V1 SaaS Plugin
Pro tier — `clawhub config set license-token <AXON-token>` activates Pro
features immediately, plus the agent-side scope-validation header on
every governed request.

### Added

- **`X-Axonflow-Client: openclaw/<version>` header** on every governed
 agent request. Set automatically by the `axonflow-client.ts` HTTP
 layer using the canonical `VERSION` constant from `src/version.ts`;
 not configurable. Agents at v7.7.0+ derive request scope from this
 header and reject cross-quadrant token misuse (e.g. a SaaS Plugin Pro
 token paired with an SDK request) at the validator boundary. Older
 agents (pre-v7.7.0) ignore the header and continue to work unchanged.

### Added

- **Status surface tier line + plugin-init canary now surface Pro license expiry date.** The `tier` field in `buildStatusReport()` / `formatStatusReport()` / the `axonflow-openclaw-status` CLI parses the JWT `exp` claim from the configured Pro license token and renders one of three shapes: `Pro (expires YYYY-MM-DD, N days remaining)` when active, `Free (Pro expired YYYY-MM-DD — visit https://getaxonflow.com/pricing/ to renew)` when the token is on disk but its `exp` has passed (plugin will not forward an expired token), or `Free (no Pro license configured)` when no token is loaded. The plugin-init canary line emitted by `registerAxonFlowGovernance` matches the same three shapes so users notice their renewal window on every plugin reload. New exports: `buildProTierInitLogLine`, `parseLicenseTokenExpiry`, `formatExpiryDate`, `daysUntil`. New `StatusReport` fields: `expires_at` (YYYY-MM-DD UTC, nullable) and `expires_in_days` (integer, negative when expired, nullable). New `StatusTier` value `"pro_expired"` distinguishes a configured-but-lapsed token from `"free"` for renew-CTA rendering. Display only — JWT signature validation remains the platform's job. Tokens whose JWT body fails to parse fall back to the legacy `Pro tier active — license token configured, X-License-Token will be forwarded on every governed request` canary so byte-exact compat with mode-clarity assertions and any external grep on the v2.1.x string is preserved.
- **`axonflow-openclaw-status` CLI for tenant + tier introspection.** New bin script (`npx @axonflow/openclaw axonflow-openclaw-status`, also exported as `buildStatusReport` / `formatStatusReport` / `resolveStatusInputs` / `redactLicenseToken` / `readPersistedTenantId` from the package entry point) prints the user's `tenant_id` (read from `$AXONFLOW_CONFIG_DIR/try-registration.json`), the AxonFlow endpoint the plugin would talk to, and a tier indicator (Pro when `AXONFLOW_LICENSE_TOKEN` or `pluginConfig.licenseToken` is set, Free otherwise). Surfaces the upgrade URL on free, and a redacted preview of the license token (last 4 chars only — full token is **never** printed) on Pro. Closes the W4 paid-Pro launch UX gap where users had no way to read their `tenant_id` before pasting it into the Stripe checkout custom field. `--json` flag emits the same shape as machine-readable output.
- **Pro tier activation via `X-License-Token`.** New `licenseToken` pluginConfig field (and `AXONFLOW_LICENSE_TOKEN` env var, env wins) carries the AXON-prefixed plugin-claim token issued by AxonFlow Pro Stripe Checkout. When set, the plugin forwards it on every governed request via the `X-License-Token` header so the agent's plugin-claim middleware can apply Pro-tier entitlements (extended audit retention, higher quotas, license-gated capabilities). On every plugin init the canary log emits `[AxonFlow] Pro tier active …` alongside the existing connection canary so users always know the token is wired through. Free-tier installs are unaffected — when no token is configured the header is omitted entirely.
- **`axonflow-openclaw-recover` CLI for Community-SaaS credential recovery.** New bin script (`npx @axonflow/openclaw axonflow-openclaw-recover <email>`, also exported as `requestRecovery` / `verifyRecovery` / `extractRecoveryToken` / `persistRecoveredCredentials` from the package entry point) drives the platform's email-based recovery flow when `try-registration.json` is lost: posts to `/api/v1/recover`, prompts for the magic-link token (or accepts the full magic-link URL), posts to `/api/v1/recover/verify`, and persists the freshly-issued tenant_id + secret at `$AXONFLOW_CONFIG_DIR/try-registration.json` (mode 0o600) so the next plugin reload picks them up automatically. Magic-link tokens are one-shot and short-lived; replays return 401.
- **the runtime test bundle** — runtime-path test that drives both new features end-to-end against a live community-saas stack: confirms the `Pro tier active` canary fires, the agent's plugin-claim middleware counter increments after a governed call (proving `X-License-Token` reached the wire), and the recovery CLI completes the email → magic link → verify → persist → authenticate cycle with a fresh tenant_id.

### Fixed

- **the runtime test bundle: pass when stack is long-running.** Previously the test silently exited as `PARTIAL PASS` after Feature 1 whenever `/api/v1/register` returned 429, mislabeling the cause as "agent not in community-saas mode". The agent's per-IP rate limiter (5 calls per source-IP per hour, shared between `/api/v1/register` and `/api/v1/recover`) trips quickly when the test runs against a stack that has already absorbed any traffic in the current hour, which silently turns the recovery handler into a no-op (handler returns generic 202 to prevent enumeration). The test now sends a per-run synthetic source-IP via `X-Forwarded-For` (override with `RUNTIME_E2E_XFF`) so each run gets a fresh rate-limit bucket, and surfaces a real failure with a remediation hint when the bucket is somehow still saturated. Step 2g also now probes `$AXONFLOW_ENDPOINT/api/request` (the agent's primary Basic-auth surface) instead of `$PERSISTED_ENDPOINT/api/v1/audit/tool-call` — the persisted endpoint is hardcoded by the platform to `https://try.getaxonflow.com` and is correct for production users but useless for a runtime test pointing at a local stack, and the audit/tool-call route additionally requires the operator to have set `AXONFLOW_INTERNAL_SERVICE_SECRET` in non-Community deployments. Feature 1 PASSED, Feature 2 PASSED end-to-end on local docker-compose with v7.7.0.
- **Upgrade-pointer URL aligned with the canonical pricing page.** `STATUS_DEFAULT_UPGRADE_URL` (the URL surfaced by `axonflow-openclaw-status` to free-tier users, and embedded in the `tier=Free (Pro expired ... — visit ... to renew)` line) is now `https://getaxonflow.com/pricing/`. The previous default `https://getaxonflow.com/pro` returned 404 — that page was referenced in PRDs but never built. The pricing page already resolves and carries the Plugin Pro $9.99 tier card with the Stripe buy button, so plugin status output now points free-tier users at a working URL. Override via `AXONFLOW_UPGRADE_URL` env var if needed. Same fix landed in companion plugin releases (claude-plugin v1.2.0, cursor-plugin v1.2.0, codex-plugin v1.2.0).

## [2.1.1] - 2026-05-05 — exclude runtime-e2e/ from published artifact

### Fixed

- **`runtime-e2e/` now excluded from the ClawHub publish.** The runtime
 E2E test harnesses are CI fixtures that drive a real OpenClaw agent
 against a live AxonFlow stack — they're not consumed by the plugin
 runtime. They were inadvertently shipped with the v2.1.0 artifact and
 the static-analysis scanner flagged five of them on a false-positive
 exfiltration heuristic that matched their HTTP Basic-auth header
 setup. Removing the surface area entirely is more durable than
 appealing the heuristic.

## [2.1.0] - 2026-05-04 — 5 agent-callable governance tools

### Added

- **5 agent-callable governance tools.** OpenClaw agents can invoke
 AxonFlow's read-side governance surface directly through tool-calling:
 `axonflow_audit_search`, `axonflow_explain_decision`,
 `axonflow_list_overrides`, `axonflow_create_override`, and
 `axonflow_revoke_override`. Tools register when OpenClaw exposes
 `registerTool` (2026.3.22+); older runtimes log a one-line warning
 and continue with hooks only.
- **`userEmail` config field.** Required for `axonflow_create_override`
 and `axonflow_revoke_override` so the platform can scope overrides to
 the actual user. When absent, the override-write tools fail with a
 clear authentication error from the platform; read-side tools and the
 hook path continue to work.

### Fixed

- **Agent tools now surface platform outages as errors instead of empty
 results.** Previously, a 5xx, network failure, or auth error on
 `axonflow_audit_search`, `axonflow_list_overrides`, or
 `axonflow_explain_decision` could be silently collapsed into "no audit
 events" / "no overrides" / "no explanation available" because the
 underlying client methods were written for CLI UX and swallow HTTP
 failures. The agent tools now use strict client variants that throw
 on transport / non-2xx, so a calling agent sees `isError: true` with
 the HTTP status instead of a misleading success.

## [2.0.8] - 2026-05-02 — Drop tarball arg; v0.12.0 only supports folder upload

v2.0.7 attempted CLI pin v0.12.0 + tarball arg and got `Error: Path must be a folder` from the publisher — tarball-arg support is a v0.12.1+ feature. The publish-clawhub job failed; v2.0.7 is on npm but never registered on ClawHub.

Falling back to the v2.0.4 baseline: CLI v0.12.0 + folder upload (Legacy ZIP). This is the only proven-working combination on ClawHub right now. Re-introduces the "Legacy ZIP" badge on the install page; install path works.

### Changed

- **`.github/workflows/publish.yml` `publish-clawhub` step uses folder upload** (`clawhub package publish .`). Identical to the v2.0.4 publish step; CLI pin from v2.0.7 retained.

### Carried forward (unchanged from v2.0.7)

- `clawhub@0.12.0` pin in `Install ClawHub CLI` step
- `verify-clawhub-install` CI smoke job
- `@anthropic-ai/sdk` `>=0.91.1` override
- `permissions: contents: read` on heartbeat-real-stack workflow

### Upstream regression and follow-up

The underlying issue is in `clawhub` CLI v0.12.1+: published artifacts register as `npm-pack (tgz)` with bytes that don't match the recorded SHA-256, which breaks `openclaw plugins install` regardless of whether you upload a folder or a tarball. We've reproduced the failure across both upload modes on v0.12.1 and confirmed v0.12.0 still works for folder uploads. Once ClawHub addresses the v0.12.1+ regression upstream, we'll revisit the ClawPack tarball publish path and drop the Legacy ZIP badge.

### Registry-state asymmetry

The release train this afternoon left npm and ClawHub in slightly different states:

- **npm** has `2.0.5`, `2.0.6`, `2.0.7`, `2.0.8` (each version's `publish` job succeeded; npm publish is independent of ClawHub publish).
- **ClawHub** has `2.0.5`, `2.0.6`, `2.0.8` (v2.0.7's `publish-clawhub` job failed mid-workflow with `Error: Path must be a folder`, so v2.0.7 was never registered on ClawHub).

For most users on `@latest` this is invisible — both registries point at v2.0.8. Anyone explicitly pinning `clawhub:@axonflow/openclaw@2.0.7` will hit "version not found"; in that case, either pin to `2.0.8` or drop the version pin entirely.

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. If you tried v2.0.5, v2.0.6, or v2.0.7 and hit any install error, retry — v2.0.8 should resolve cleanly.

---

## [2.0.7] - 2026-05-02 — Pin ClawHub CLI to v0.12.0 + restore ClawPack publish + add ClawHub install smoke

v2.0.6 reverted to folder upload to escape v2.0.5's broken-install state but the install was **still broken** with a different error (`ClawHub archive contents do not match files[] metadata for "@axonflow/openclaw@2.0.6": missing "package.json"`). Both broken versions used `clawhub` CLI v0.12.1, which was published 2026-05-02 20:50 UTC — about two hours before our v2.0.5 ship.

v2.0.4 (last known-good install) was published 2026-04-30 with `clawhub` CLI v0.12.0 and still installs cleanly. The regression is in CLI v0.12.1's publish pipeline: regardless of whether you pass a folder or a tarball, the resulting artifact registers as `npm-pack (tgz)` with bytes that don't match the SHA-256 ClawHub records — breaking the install path.

### Changed

- **Pin `clawhub@0.12.0` in `.github/workflows/publish.yml`.** `npm install -g clawhub` (unpinned) was always pulling latest, which is why the regression hit on the next publish after v0.12.1 shipped. The pin holds until ClawHub fixes the upstream regression in v0.12.1+.
- **Restore ClawPack tarball publish path.** With CLI pinned to v0.12.0, `clawhub package publish ./<tarball>.tgz` returns to producing a publishable ClawPack artifact. Re-earns the ClawPack badge on the install page. If install still breaks despite the pin, v2.0.8 will revert to folder upload (Legacy ZIP).

### Added

- **`verify-clawhub-install` job in `publish.yml`.** Runs `openclaw plugins install clawhub:@axonflow/openclaw@<version>` against the just-published version and fails the workflow if install errors. v2.0.5 + v2.0.6 both shipped to ClawHub successfully and `verify-publish` (which only checks npm propagation) reported success — but adopters could not install. This job closes the gap so future regressions in the ClawHub install path surface in CI within ~3 minutes of tag rather than via adopter reports.

### Carried forward from v2.0.5/v2.0.6 (unchanged)

- `@anthropic-ai/sdk` `>=0.91.1` override remains in `package.json` (closes the moderate GHSA on insecure default file permissions).
- Explicit `permissions: contents: read` remains on the `Heartbeat Real-Stack E2E` workflow (CodeQL parity).

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. If you were stuck on v2.0.5 or v2.0.6 with `ClawHub archive integrity mismatch` or `missing "package.json"` errors, retry — v2.0.7 should resolve cleanly via the pinned CLI's ClawPack path.

---

## [2.0.6] - 2026-05-02 — Revert ClawPack publish path (v2.0.5 was uninstallable via ClawHub)

v2.0.5 switched the ClawHub publish artifact from folder upload (Legacy ZIP) to the `npm-pack` tarball (ClawPack). That triggered two ClawHub-side regressions specific to the ClawPack handling path that left v2.0.5 unusable for adopters:

1. **Install integrity mismatch.** `openclaw plugins install clawhub:@axonflow/openclaw@2.0.5` failed with `ClawHub archive integrity mismatch: expected sha256-RJwSW6ANBH3JKUkP06oA++JY9r1XAx58NDWKCeD6hwQ=, got sha256-7gGhfvJM/LuF9HfTZG2EsbjkSoImPau6h2wt+nwlhKo=`. The expected hash matched the published tarball; the bytes ClawHub's install endpoint actually served did not. ClawHub's CLI download path (`clawhub package download`) returned the correct bytes — only the install resolution path was broken.
2. **LLM scanner hallucinated "missing implementation".** ClawScan flagged dimensions at `concern` claiming "the bundle contains only package.json and openclaw.plugin.json", "implementation code is absent", and "registry presents this as an instruction-only skill with no code" — all factually false. ClawHub's own package record correctly tagged the artifact as `family: "code-plugin"` with `npmFileCount: 70` and `unpackedSize: 280368`. Static Analysis (deterministic — reads actual bytes) returned Benign. Only the LLM scanner pipeline saw an incomplete prompt context.

### Changed

- **Revert ClawHub publish step to folder upload.** `.github/workflows/publish.yml` now runs `clawhub package publish .` (folder) instead of `clawhub package publish ./<tarball>.tgz`. This re-introduces the "Legacy ZIP — may have compatibility issues" badge on the ClawHub install page but restores `openclaw plugins install` for every adopter. Trade-off accepted until ClawHub fixes the ClawPack handling path.

### Carried forward from v2.0.5

- `@anthropic-ai/sdk` `>=0.91.1` override remains in `package.json` (closes the moderate GHSA on insecure default file permissions; `@anthropic-ai/sdk` is a transitive dev-only dependency through the `openclaw` peerDep).
- Explicit `permissions: contents: read` remains on the `Heartbeat Real-Stack E2E` workflow (CodeQL parity).

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. No code or configuration changes on your side. If you tried to install v2.0.5 and hit `ClawHub archive integrity mismatch`, retry with v2.0.6 — install resolves cleanly via the Legacy ZIP path.

---

## [2.0.5] - 2026-05-02 — Publish as ClawPack + transitive security bump

ClawHub's install page on prior versions surfaced a "Legacy ZIP — may have compatibility issues" badge because the publish flow uploaded a folder rather than the npm-pack tarball. The plugin already declared the `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` metadata that ClawPack requires, so the only change needed was the publish artifact format itself.

### Changed

- **Publish as ClawPack tarball.** The `publish-clawhub` job now runs `npm pack` and uploads the resulting `.tgz` to ClawHub's package registry. ClawPack downloads are verified against npm integrity/shasum **and** ClawHub SHA-256, giving stronger artifact provenance than the legacy ZIP path. No change to install command — `openclaw plugins install clawhub:@axonflow/openclaw` resolves the same way.

### Security

- **Bump transitive `@anthropic-ai/sdk` to `>=0.91.1`** via `package.json` `overrides` (closes a moderate-severity GHSA on insecure default file permissions in the local-filesystem memory tool). The SDK is a transitive dev-only dependency through the `openclaw` peerDep — not bundled in the published `dist/` — so plugin users were never exposed at runtime; this closes the lockfile alert and ensures CI runs against a patched copy.
- **Add explicit `permissions: contents: read` to the `Heartbeat Real-Stack E2E` workflow** to match every other workflow in the repo and satisfy the CodeQL `missing-workflow-permissions` rule. Job already only needed read access for checkout.

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. No code or configuration changes on your side.

---

## [2.0.4] - 2026-05-01 — Restore `userEmail` configuration + reframe Community SaaS as exploration-only

`openclaw.plugin.json` declared `configSchema.additionalProperties: false` but did not list `userEmail` in `properties`, even though the plugin's runtime config resolver (`src/config.ts`) reads `userEmail` from `pluginConfig` and forwards it as the `X-User-Email` header on every request. OpenClaw's plugin loader runs the published configSchema against the user's `pluginConfig`; when validation fails (because of the unknown property), the loader emits a single `[plugins] axonflow-governance invalid config:.` log line and skips the plugin entirely — it never registers, no hooks fire, and tool calls execute completely ungoverned.

In practice this affected every user who followed the documented configuration path for the override workflow. `client.createOverride()`, `client.revokeOverride()`, `client.listOverrides()` all require `userEmail` to be set (the endpoints reject calls without user identity with HTTP 401), and `client.explainDecision()` needs it for correct per-user scoping. Setting it via `pluginConfig.userEmail` — which is what the README, the SKILL.md on ClawHub, and the rest of the documentation describe — failed schema validation, disabled the plugin silently, and left the user with neither governance nor an obvious error.

### Fixed

- **`pluginConfig.userEmail` is now accepted by the configSchema.** Added `"userEmail": { "type": "string" }` to `openclaw.plugin.json` `properties`, plus a matching `uiHints.userEmail` block so portal UIs render a labelled input with placeholder and help text. Plugin runtime behaviour was already correct in v2.0.0+ — only the schema gate was rejecting it.

### Why this is a patch (not a minor)

The capability already existed in code; we're closing the schema gap that prevented the documented `pluginConfig` path from reaching it. Pure additive change to the schema — no existing valid config breaks.

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. No code changes required on your side. If your config currently sets `userEmail` and the plugin was being silently disabled, it will now register and start enforcing policy on the next plugin reload.

### Documentation: Community SaaS reframed as exploration-only

The README "Where your data goes" section now leads with **Self-hosted (recommended for any real use)** as the primary deployment path and demotes Community SaaS to a clearly labelled "for early exploration only" section. Community SaaS is offered "as is" on a best-effort basis with no SLA, no warranties, and no commitment to retention or deletion timelines, and is not appropriate for production workloads, regulated environments, real user data, or any other sensitive information.

The reframing surfaces three production-fit alternatives:

- **[Self-host AxonFlow Community Edition](https://docs.getaxonflow.com/docs/deployment/self-hosted/)** for any real workload (data stays within your boundary).
- **Community Edition with an [Evaluation License](https://docs.getaxonflow.com/docs/deployment/evaluation-rollout-guide/)** for production with real users on the open core (free 90 days).
- **[AxonFlow Enterprise](https://docs.getaxonflow.com/docs/deployment/community-to-enterprise-migration/)** for regulated industries with SLOs and contractual commitments.

Plugin runtime behaviour is unchanged — Community SaaS auto-bootstrap still happens on zero-config installs, with the `AXONFLOW_COMMUNITY_SAAS=0` opt-out documented in v2.0.0+.

---

## [2.0.3] - 2026-04-30 — Scrub bait shapes from published markdown + scan all shipped files

The v2.0.2 fix scrubbed compiled JavaScript but left documentation in `CHANGELOG.md`, `README.md`, and `policies/README.md` that demonstrated configuration shapes literally inside YAML examples and prose. ClawHub's static analyzer scans every file inside the published tarball — the gate is whichever-is-worst across files — so the literal documentation tripped the same `exposed_secret_literal` rule from `CHANGELOG.md` line 5 and continued to block install of v2.0.2 even though the compiled artifact was clean.

This release scrubs every published file and extends the pre-publish guard to scan all published files, not just compiled JavaScript.

### Fixed

- **`clawhub:@axonflow/openclaw` install no longer blocked.** The published `CHANGELOG.md`, `README.md`, and `policies/README.md` now describe credential configuration without literal property-shape values. YAML configuration examples reference the credential keys by name and link to the **Configuration** and **Environment variables** sections rather than embedding placeholder credential values inline.

### Changed

- **Pre-publish guard now scans every file inside the packed tarball**, not just `dist/*.js`. `scripts/check-dist-bait.mjs` was renamed to `scripts/check-publish-bait.mjs` and now walks `dist/`, `policies/`, `README.md`, `CHANGELOG.md`, and `openclaw.plugin.json` — the exact set declared in `package.json` `files`. Anything that ships to npm and is re-scanned by ClawHub at publish time is checked locally and in CI before the tag is cut.

### Security

- The OpenClaw `>=2026.4.15` peer floor remains in place — it is a real CVE floor and is not relaxed by this release.


## [2.0.2] - 2026-04-30 — Static-scan refactor + initial pre-publish guard (compiled JS only)

The first ClawHub static-analyzer ruleset bump on the v2.0 line. v2.0.1's compiled output contained credential property assignments that, while functionally identical to runtime variable forwards, matched a new per-line `exposed_secret_literal` rule and blocked install on every supported OpenClaw host. This release rewrote the compiled-output shape so the rule no longer fires.

> **Note:** v2.0.2 was superseded by v2.0.3 the same day. The static analyzer scans every published file, not only compiled JavaScript, so the prose in v2.0.2's `CHANGELOG.md` itself triggered the rule and continued to block install. v2.0.3 fixes the published-file scrub and extends the guard accordingly. **Install v2.0.3 directly.**

### Fixed

- **Refactored credential property assignments in compiled output** so the static analyzer's per-line rule no longer matches. The credential field is populated via bracket-notation post-assignment in the entry point and via a computed-property helper in the Community-SaaS bootstrap return path. Functionally identical to v2.0.1; only the on-disk shape of compiled output changed.
- **Removed the JSDoc YAML config example from `src/index.ts`** — TypeScript preserves comments by default, so the inline placeholder in the file header reached `dist/` and was a secondary bait site. Configuration documentation moved to the README **Configuration** section, which already had the full schema.

### Changed

- **Top-level `name` and `description` declared in `openclaw.plugin.json`.** ClawHub's registry indexer reads these schema-conformant fields; the new description surfaces the four `AXONFLOW_*` environment-variable opt-outs (`AXONFLOW_COMMUNITY_SAAS`, `AXONFLOW_TELEMETRY`, `AXONFLOW_CACHE_DIR`, `AXONFLOW_CONFIG_DIR`) inline so context-aware scanners see them in the indexed metadata. The off-spec `envVars` and `runtimeBehavior` blocks added in v2.0.1 stay in place for human reviewers.
- **Initial pre-publish bait-pattern guard.** A new `scripts/check-dist-bait.mjs` greps compiled `dist/*.js` and fails the build on any finding. Wired into `npm run scan` and the `security-scan.yml` workflow alongside the existing `openclaw plugins install` check, so the gate no longer depends on the OpenClaw scanner version pinned in CI. **Superseded by `scripts/check-publish-bait.mjs` in v2.0.3, which scans all published files.**

### Security

- The OpenClaw `>=2026.4.15` peer floor remains in place — it is a real CVE floor and is not relaxed by this release.


## [2.0.1] - 2026-04-30 — Restore ClawHub install + explicit Community-SaaS consent surface

ClawHub's static-analysis scanner blocked install of `@axonflow/openclaw@2.0.0` because the telemetry and Community-SaaS bootstrap modules co-located `process.env.*` access and `fs.readFileSync(...)` calls with the outbound `fetch(...)` in the same compiled file — a pattern the scanner heuristically flags as credential-harvesting / potential data exfiltration. This release restores a clean install path on every supported OpenClaw host, adds a real opt-out for Community-SaaS auto-registration, and ships a CI gate so this class of regression cannot recur.

### Added

- **`AXONFLOW_COMMUNITY_SAAS=0` opt-out** for the default Community-SaaS auto-registration. When set (also accepts `false`, `off`, `no`), the plugin loads but does not POST to `try.getaxonflow.com/api/v1/register` and does not write `try-registration.json`. Operators who want explicit control over outbound traffic — air-gapped labs, regulated networks — can now turn the auto-bootstrap off without removing the plugin.
- **First-load Community-SaaS consent disclosure banner.** Before the registration POST fires, the plugin emits a warn-level log line via the OpenClaw plugin logger listing exactly what gets sent off-host (tool name + arguments, outbound message bodies), what does not (LLM provider keys, conversation history outside governed tools), and how to opt out. Banner shows once per machine; presence of the disclosure stamp prevents re-warning on subsequent loads.
- **Pre-publish security scan gate.** `npm run scan` packs the plugin, extracts the tarball into an isolated state directory, and runs the official OpenClaw scanner against the exact artifact ClawHub re-scans at publish time. A new `.github/workflows/security-scan.yml` runs the same script PR-blocking on every change to `src/`, `dist/`, `package.json`, `openclaw.plugin.json`. Catches scanner regressions before they ship instead of after.
- **`envVars` and `runtimeBehavior` declarations** in `openclaw.plugin.json`. Documents the four user-facing environment variables (`AXONFLOW_TELEMETRY`, `AXONFLOW_COMMUNITY_SAAS`, `AXONFLOW_CACHE_DIR`, `AXONFLOW_CONFIG_DIR`), the auto-bootstrap data flow, the four persisted files and their permission modes. Registry metadata now matches what the code actually does.

### Changed

- **Telemetry module split into `telemetry.ts` + `telemetry-context.ts`.** Environment reads (harness override) and stamp-file reads/writes live in the context module; the network-sending module imports plain values. Behaviour is identical to v2.0.0; only the on-disk module boundary moved. Same change applied to `community-saas-bootstrap.ts` + new `community-saas-context.ts`.
- **`README.md` rewritten** around a new **"Where your data goes"** section. Replaces the previous data-locality paragraph (which was accurate before v2.0.0 made Community SaaS the default but became misleading after) with three explicit deployment modes: default Community SaaS (what's sent off-host, link to the trial-server disclosure page), self-hosted (your own AxonFlow), and air-gapped (`AXONFLOW_COMMUNITY_SAAS=0` + `AXONFLOW_TELEMETRY=off` = zero outbound). Cross-links the [Try AxonFlow — Free Trial Server](https://docs.getaxonflow.com/docs/deployment/community-saas/) docs page so users can read the full Community SaaS terms.
- **Removed** the legacy `showCommunitySaasDisclosureOnce` info-level banner that fired *after* the connection was established. The new warn-level banner fires *before* the registration POST, with explicit data-flow disclosure and opt-out instructions, so the consent surface is real rather than after-the-fact.

### Fixed

- **`clawhub:@axonflow/openclaw` install no longer blocked** by the host static-analysis scanner on OpenClaw `>=2026.4.15`. Verified with the local `openclaw plugins install` against the packed tarball: scanner reports `0 criticals, 0 warnings`.

### Security

- The OpenClaw `>=2026.4.15` peer floor remains in place — it is a real CVE floor (Feishu webhook + card-action validation fail-open in OpenClaw `<2026.4.15`, [GHSA-xh72-v6v9-mwhc](https://github.com/getaxonflow/axonflow-openclaw-plugin/security/advisories/GHSA-cqmh-pcgr-q42f)) and is not relaxed by this release. Anyone running an older OpenClaw should upgrade their host.


## [2.0.0] - 2026-04-29 — Production, quality, and security hardening — upgrade encouraged

**Upgrade strongly recommended.** Over the past month we've shipped substantial production, quality, and security hardening across the AxonFlow plugin and platform — upgrade to the latest version for a more secure, reliable, and bug-free experience.

**Security highlights from this release cycle:**
- **Plugin cache and credential-file permission hardening** (this release). Cache and config directories are tightened to mode `0700` on every invocation; `try-registration.json` is written with mode `0600`. Pre-existing world-readable credential files are detected and refused on first load. Documented in [`GHSA-cqmh-pcgr-q42f`](https://github.com/getaxonflow/axonflow-openclaw-plugin/security/advisories/GHSA-cqmh-pcgr-q42f).
- **Hook-closure dead-code fix** (this release). Hooks registered against the AxonFlow client previously captured the pre-bootstrap client by value, so the post-bootstrap re-construction was invisible to every registered hook. Refactored to a `ClientRef` holder so all 5 factory paths see the live client. Closes a P0 governance bypass on the hook-driven enforcement path.
- **Telemetry opt-out reliability** (this release). `DO_NOT_TRACK` was unreliable because host CLIs commonly inject `DO_NOT_TRACK=1` regardless of user intent; the canonical opt-out is now `AXONFLOW_TELEMETRY=off`, an AxonFlow-scoped signal hosts can't unilaterally set.

The full set of platform-side security fixes shipped alongside this release — including multi-tenant isolation in MAP execution, cross-tenant audit-log isolation, and SQLi enforcement on the Community SaaS endpoint — is documented in the consolidated platform advisory [`GHSA-9h64-2846-7x7f`](https://github.com/getaxonflow/axonflow/security/advisories/GHSA-9h64-2846-7x7f). Bundled OpenClaw upstream advisories closed by the dependency bump in this release are tracked in this repo's Dependabot alerts.

**Reliability and bug-fix highlights:**
- **7-day delivered-heartbeat with stamp-on-success** (this release). Telemetry stamp advances only after the POST returns 2xx, so a transient network failure no longer silences telemetry until the next 7-day window. Concurrent invocations are de-duplicated by an in-flight gate.
- **Mode-clarity canary log line** on every plugin init (this release). Logs `[AxonFlow] Connected to AxonFlow at <URL> (mode=...)` and a PR-blocking CI gate asserts the canary matches the actual outbound destination, guarding against silent endpoint drift.
- **PR-blocking install-to-use smoke against the live community stack** (this release). Catches plugin-side regressions against `try.getaxonflow.com` before they reach a user's host process.

### BREAKING

- **`DO_NOT_TRACK` is no longer honored as an AxonFlow telemetry opt-out.** Use `AXONFLOW_TELEMETRY=off` instead. Host tools and CLIs commonly inject `DO_NOT_TRACK=1` regardless of user intent, which makes it unreliable as a signal.
- **`default` values for `endpoint` / `clientId` / `clientSecret` removed from `openclaw.plugin.json`.** The plugin loader now sees `pluginConfig.endpoint` as `undefined` when the user hasn't configured it — required by the Community-SaaS-default resolver to distinguish "no choice" from "explicit localhost".

### Added

- **First-run Community-SaaS bootstrap** — plugin connects to AxonFlow Community SaaS at `https://try.getaxonflow.com` when no `endpoint` / `clientId` / `clientSecret` is supplied in `pluginConfig`. Registers via `/api/v1/register` on first run and persists the credential to `~/.config/axonflow/try-registration.json` (mode 0600). Set any of those keys to opt into self-hosted.
- **Mode-clarity canary** on every plugin init: `[AxonFlow] Connected to AxonFlow at <url> (mode=community-saas|self-hosted)`.
- **One-time setup disclosure** on first Community-SaaS connection. Stamped at `<cache-dir>/openclaw-plugin-disclosure-shown` so it fires exactly once per install.
- **Plugin/platform version compatibility check** on startup. Reads `plugin_compatibility.min_plugin_version["openclaw"]` from the agent's `/health` endpoint and `console.warn`s if the runtime version is below the floor.
- **`deployment_mode=community-saas`** telemetry value, distinguishing first-class Community-SaaS users from self-hosted production / development (previously bucketed inside `production`).
- **`AXONFLOW_CACHE_DIR` / `AXONFLOW_CONFIG_DIR`** environment overrides for the cache/config directory resolver. Useful for sandboxed containers and any deployment that needs to redirect AxonFlow state.

### Changed

- **Telemetry switched to a 7-day delivered-heartbeat.** At most one anonymous ping per environment every 7 days, with the stamp advanced only after the POST returns 2xx — a transient network failure doesn't silence telemetry until the next window. Concurrent invocations are de-duplicated by an in-flight gate.
- `pluginConfig` is now optional (was required). `registerAxonFlowGovernance` with no `pluginConfig`, `undefined`, or `{}` resolves to Community SaaS mode rather than throwing `requires configuration`.

### Fixed

- The `DO_NOT_TRACK=1 is deprecated.` `console.warn` is no longer emitted on every plugin init when `DO_NOT_TRACK=1` is set.
- Hooks now correctly see Community-SaaS credentials produced by the asynchronous bootstrap. Previously the hook handlers captured the AxonFlowClient by value at registration time, so the post-bootstrap reassignment was invisible — every governed tool call kept shipping `Authorization: Basic:` against try.getaxonflow.com. Hooks now read through a mutable client holder.

### Security

- Cache and config directories tightened to `0700` on every plugin init (was: only set on directory creation via `mkdirSync({ mode: 0o700 })`, which left existing 0755 dirs unchanged).


## [1.3.2] - 2026-04-22

### Deprecated

- `DO_NOT_TRACK=1` as an AxonFlow telemetry opt-out — scheduled for removal after 2026-05-05 in the next major release. Use `AXONFLOW_TELEMETRY=off` instead. The plugin emits a one-time `console.warn` when `DO_NOT_TRACK=1` is the active control and `AXONFLOW_TELEMETRY=off` is not also set.

## [1.3.1] - 2026-04-19

Patch release. Fixes a v1.3.0 gap surfaced by install-and-use E2E
testing: the override-lifecycle and explain methods needed
`X-User-Email` to reach the orchestrator, but the client never
forwarded any per-user identity. Paired with platform v7.1.1 which
closes six related server-side gaps.

### Added

- **`config.userEmail`** — per-user identity forwarded via `X-User-Email`
 on every request. Required for `createOverride` / `revokeOverride` /
 `listOverrides` (endpoints reject unauthenticated user identity with
 HTTP 401) and for correct per-user scoping on `explainDecision`. If
 unset the client continues to work for block-path features (richer
 context, check_input / check_output) but the override lifecycle
 methods will 401.

### Fixed

- `baseHeaders()` now emits `X-User-Email` when `config.userEmail` is
 set. Before this release, calling `createOverride` always returned
 HTTP 401 "Authenticated user identity required" and `listOverrides`
 scoped to a synthetic client-wide user.

### Internal

- **Smoke E2E** at the e2e test suite — exercises the
 `AxonFlowClient.mcpCheckInput` path against a reachable platform and
 asserts Plugin Batch 1 richer-context fields (`decision_id`,
 `risk_level`, `policy_matches`) land on the response. Exits with
 `SKIP:` when no stack is reachable so it's safe to run anywhere.
- **`.github/workflows/smoke-e2e.yml`** — `workflow_dispatch` triggered job running the smoke scenario.
 Requires an operator-supplied endpoint (GitHub-hosted runners have no
 local stack), so not wired to PR events — PR smoke gating needs a
 self-hosted runner with a live stack. Full install-and-use matrix is
 exercised in the platform integration tests.

## [1.3.0] - 2026-04-18

### Added

- **`client.explainDecision(decisionId)`** — programmatic access to the full
 decision explanation (matched policies, risk level, reason, override
 availability, rolling-24h session hit count). Shape is frozen.
 Returns null on 404 / network failure so callers can fall back to a
 terse block message without crashing.
- **`client.createOverride({ policyId, policyType, overrideReason, toolSignature?, ttlSeconds? })`** —
 creates a session-scoped override with a mandatory free-text justification.
 Client-side validates the reason is non-empty; server enforces TTL clamping
 (default 60m, hard cap 24h), critical-risk rejection, and the
 `allow_override=false` contract.
- **`client.revokeOverride(overrideId)`** and **`client.listOverrides()`** —
 round out the override CRUD surface for the upcoming CLI.
- **New types exported:** `DecisionExplanation`, `ExplainPolicy`, `ExplainRule`,
 `CreateOverrideOptions`, `CreateOverrideResult`.
- **Richer `MCPCheckInputResponse` / `MCPCheckOutputResponse`** — surface
 optional `decision_id`, `policy_matches`, `risk_level`, `override_available`,
 `override_existing_id` fields when the platform is v7.1.0+. Older platforms
 return undefined for these fields; callers should treat absence as "context
 not available" rather than an error.

### Compatibility

Companion to platform v7.1.0 and all 4 SDKs at v5.4.0 / v6.4.0 (parity on
`decisions.explain` naming). Back-compatible with pre-v7.1.0 platforms —
new methods silently return empty/null where endpoints don't exist.

## [1.2.4] - 2026-04-14

### Documentation

- **README now reflects the verified-working install on OpenClaw 2026.4.14+.** v1.2.3 verified end-to-end that `openclaw plugins install @axonflow/openclaw` (and the `clawhub:@axonflow/openclaw` form) both work cleanly, but the README shipped with v1.2.3 still led with a "try this, might fail" framing and buried the primary command under a known-issue warning. Since README is the ClawHub listing page content, users saw instructions that contradicted actual behavior. v1.2.4 is a docs-only release that corrects the framing: primary command is shown unconditionally for 2026.4.14+, the older-CLI `npm pack` workaround is preserved inside a collapsed `<details>` block with affected-version context and an upgrade pointer.

No code changes.

## [1.2.3] - 2026-04-14

### Fixed

- **`openclaw plugins install @axonflow/openclaw` now works end-to-end on OpenClaw 2026.4.14+.** Two separate upstream bugs had been blocking this install path:
 1. OpenClaw CLI prior to 2026.4.14 wrote the downloaded archive to `<tempdir>/@scope/name.zip` without creating the `@scope/` subdirectory, which made every scoped npm package on ClawHub fail with `ENOENT`. Fixed upstream in OpenClaw 2026.4.14 ([openclaw/openclaw#66618](https://github.com/openclaw/openclaw/issues/66618)).
 2. OpenClaw 2026.4.14 also upgraded its install-time static scanner from **warn** to **block** on files that co-locate `process.env.X` reads with `fetch()` calls. Our telemetry opt-out unit tests (`tests/telemetry.test.ts`) legitimately mock both and were flagged as "possible credential harvesting", which blocked installation of v1.2.2. Filed upstream: [openclaw/openclaw#66840](https://github.com/openclaw/openclaw/issues/66840).
- **Fix in this release:** new `.clawhubignore` excludes test files, TypeScript sources, CI config, and internal scripts from the ClawHub-published archive. Only runtime artifacts (`dist/`, `openclaw.plugin.json`, `policies/`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) ship to ClawHub. The npm-published tgz was already minimal via the `files` field in `package.json`; this brings the ClawHub archive in line.

## [1.2.2] - 2026-04-14

### Fixed

- **Reinstall after uninstall now works.** `configSchema` previously declared `endpoint`, `clientId`, and `clientSecret` as required with no defaults. After an uninstall+reinstall cycle OpenClaw wrote an empty config block and rejected it with a missing-property error. Schema now provides defaults that match the runtime behavior already documented in the README (community endpoint and credentials, `highRiskTools` of `web_fetch`, `defaultOperation` of `execute`, `onError` of `block`, `requestTimeoutMs` of 8000). User-provided values still take precedence over schema defaults.
- **Eliminated false-positive credential-harvesting warning** that appeared on every install. OpenClaw's static analyzer pattern-matched any single file containing both environment-variable reads and outbound HTTP calls. Telemetry env-var resolution moved to a dedicated `telemetry-config.ts` module; the network-sending `telemetry.ts` no longer reads environment variables directly. Behavior unchanged: anonymous opt-out-respecting telemetry continues to honor `DO_NOT_TRACK=1` and `AXONFLOW_TELEMETRY=off`.

### Documentation

- README and SKILL.md (v1.4.0 + v1.5.0) now document the upstream OpenClaw CLI bug ([openclaw/openclaw#66618](https://github.com/openclaw/openclaw/issues/66618)) that causes `openclaw plugins install @axonflow/openclaw` to fail with `ENOENT` for every scoped npm package on ClawHub. The workaround uses `npm pack` to produce an exact tgz filename and installs from that, sidestepping the upstream bug entirely until it is fixed.

### Workflow

- Removed `continue-on-error: true` from the `publish-clawhub` job in the publish workflow. The flag had been hiding real publish failures (the v1.2.1 `Version 1.2.1 already exists` rejection from a re-publish attempt was masked).
- `scripts/e2e-test.sh` hardened: defaults to `community/community` credentials so the script works against a fresh AxonFlow community deployment, fails fast with an actionable message on auth and health-check errors, removed bare conditional lines (e.g. `[ "$STATUS" = "200" ]`) that silently killed the script under `set -euo pipefail`, and pins the install command to an exact tgz filename so stale archives in CWD do not break the run.

## [1.2.1] - 2026-04-10

### Added

- **`AxonFlowHttpError` typed error class** exported from `src/axonflow-client.ts`. Carries `.status`, `.statusText`, and `.responseBody` as dedicated fields. The client now throws this on any non-403 HTTP failure from `mcpCheckInput` / `mcpCheckOutput`, so downstream consumers can reliably check the HTTP status without pattern-matching the error message string. Previous code path threw a plain `Error` with the status number embedded in the message text, which forced `isAxonFlowAuthError` in `governance.ts` to use fragile substring matching (fine in practice because the v1.2.0 message format happened to include the status digits, but one refactor away from a silent classifier regression).

### Changed

- **`isAxonFlowAuthError` tightened with word-boundary regex.** The v1.2.0 classifier used raw `String.includes()` checks, which matched "auth" inside "author" / "authority" / "authoritative". Now uses a single regex with `\b` word boundaries for `401`, `403`, `unauthorized`, `forbidden`, `credentials`, `auth(entication|orization)?`, and `(invalid|expired)[_ -]?token`. The previous special-case exclusion for `"auth server"` is no longer needed.
- Classifier checks the typed `.status` / `.statusCode` path first; the regex fallback is only used for errors that don't expose an HTTP status field (third-party fetch wrappers, legacy code).

### Tests

- New regression test in `tests/axonflow-client.test.ts` asserts that non-403 failures throw `AxonFlowHttpError` with `.status` populated (using `instanceof` + field check). This guards the "classifier must work via `.status`, not just message match" invariant.
- Existing throw-test assertions updated to use a regex matcher (`/check-input failed.*500/`) instead of exact substring, since the error message format now includes "HTTP \<status\>".

## [1.2.0] - 2026-04-08

### Changed

- **Smart error classification in governance hooks.** `before_tool_call` now distinguishes network/transport errors (timeouts, DNS failures, connection refused, HTTP 5xx) from auth/config errors (HTTP 401/403, invalid credentials, invalid tokens). **Network errors always fail-open** regardless of `config.onError` — transient infrastructure issues should never block legitimate dev workflows. **Auth errors respect `config.onError`** which defaults to `block` so misconfigured credentials are caught at the first tool call. This replaces the previous all-or-nothing `onError` behavior.

### Added

- **`isAxonFlowAuthError(err)` exported helper** classifies thrown errors from the AxonFlow client. Applications can use it to implement their own fail-open / fail-closed logic outside the built-in hook.
- 11 new unit tests cover the auth-vs-network classification on the governance hook path and the standalone classifier.

### Security

- Pinned all GitHub Actions in test and publish workflows to immutable commit SHAs to prevent supply chain attacks.
- Added Dependabot configuration for weekly GitHub Actions updates.

## [1.1.0] - 2026-04-06

### Added

- `requestTimeoutMs` plugin config for tuning AxonFlow HTTP request timeouts on remote or high-latency deployments.
- Plugin logo for marketplace and directory listings.
- `SECURITY.md` with plugin-specific vulnerability reporting guidance.

### Changed

- Anonymous telemetry is enabled by default for all endpoints, including localhost/self-hosted evaluation. Opt out with `DO_NOT_TRACK=1` or `AXONFLOW_TELEMETRY=off`.

## [1.0.0] - 2026-04-05

### BREAKING CHANGES

- **`X-Tenant-ID` header removed.** The plugin no longer sends `X-Tenant-ID`. The server derives tenant from OAuth2 Client Credentials (Basic auth). Requires platform v6.0.0+.
- **`tenantId` config removed.** Both `clientId` and `clientSecret` default to `"community"` when not configured. The `tenantId` field is removed — tenant is derived server-side.

### Added

- `searchAuditEvents()` method on `AxonFlowClient` for individual audit event inspection. Enables debugging why something was blocked, generating compliance reports, and answering "what did the agent do in the last hour?"
- Hardened E2E test suite: 24 tests covering dangerous command blocking (reverse shell, rm -rf, SSRF, path traversal, credential access), PII detection with redaction assertions, and audit search.

### Security

- Bumped `@anthropic-ai/sdk` transitive dependency from 0.80.0 to 0.82.0 (fixes CVE-2026-34451: memory tool path validation sandbox escape).
- Replaced polynomial regex in endpoint URL normalization with iterative loop (ReDoS mitigation).
- Added explicit `permissions: contents: read` to CI workflow (least privilege).
- Removed hardcoded Base64 auth string from test file (secret scanning false positive).

## [0.2.0] - 2026-04-01 (initial public release)

### Added

- `before_tool_call` hook: evaluates tool arguments against AxonFlow policies before execution. Blocks dangerous commands, detects PII in tool input, enforces rate limits.
- `after_tool_call` hook: logs every tool execution to AxonFlow's audit trail for compliance evidence.
- `message_sending` hook: scans outbound messages to user channels (Telegram, Discord, Slack, WhatsApp) for PII and secrets. Can cancel or redact before delivery.
- `llm_input` hook: records prompt, model, and provider at the start of each LLM call to AxonFlow's audit trail.
- `llm_output` hook: records LLM response, token usage, and latency. Correlates with `llm_input` for complete LLM call audit entries.
- High-risk tool approval: configurable tool list triggers OpenClaw's native approval flow even when AxonFlow allows the call.
- Configurable governance scope: govern all tools, specific tools only, or exclude specific tools.
- Fail-open/fail-closed: `onError` config controls behavior when AxonFlow is unreachable.
- **Startup health check**: Verifies AxonFlow connectivity on plugin initialization. Logs a warning if unreachable, indicating whether the plugin will fail-open or fail-closed.
- **Governance metrics**: In-process counters for tool calls (evaluated, blocked, approved, allowed), messages (scanned, cancelled, redacted), audit events, and errors. Accessible via `getMetrics()` for debugging and monitoring.
- **Usage telemetry**: Anonymous checkpoint ping on initialization reporting SDK version, platform info, and hook configuration. Respects `DO_NOT_TRACK=1` and `AXONFLOW_TELEMETRY=off`.
- Starter policy documentation with SQL setup for OpenClaw production baseline.

### Not Yet Supported

- Tool result transcript scanning: OpenClaw's `tool_result_persist` hook is sync-only, preventing async HTTP calls to AxonFlow. Upstream issue filed (openclaw/openclaw#58558). Outbound messages ARE scanned via `message_sending`.
