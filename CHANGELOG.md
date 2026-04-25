# Changelog

## [Unreleased]

### Added

- **Wire-shape contract gate** (`.github/workflows/wire-shape-contract.yml`). CI fails any PR that introduces drift between the plugin's wire-bound TypeScript interfaces (`MCPCheckInputResponse`, `MCPCheckOutputResponse`, `ExplainPolicy`, `ExplainRule`, `DecisionExplanation`, `CreateOverrideResult`) and the AxonFlow agent's OpenAPI spec at the SHA pinned in `tests/fixtures/wire-shape-baseline.json`. Drift NOT covered by the baseline blocks merge. The pinned SHA is itself guarded by a `spec-pin-bump` PR label so a single PR can't both move the SHA and silence drift. Mirrors the four SDK gates (TS / Python / Go / Java) per ADR-047. Initial baseline grandfathers 3 per-type drift entries (Plugin Batch 1 / ADR-042 / ADR-043 fields not yet in spec) + 3 unmapped types (`ExplainPolicy`, `ExplainRule`, `DecisionExplanation` — explainability shapes the spec doesn't carry yet) for burndown via platform-side spec follow-ups.

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

- **Smoke E2E** at `tests/e2e/smoke-block-context.mjs` — exercises the
  `AxonFlowClient.mcpCheckInput` path against a reachable platform and
  asserts Plugin Batch 1 richer-context fields (`decision_id`,
  `risk_level`, `policy_matches`) land on the response. Exits with
  `SKIP:` when no stack is reachable so it's safe to run anywhere.
- **`.github/workflows/smoke-e2e.yml`** — `workflow_dispatch` triggered job running the smoke scenario.
  Requires an operator-supplied endpoint (GitHub-hosted runners have no
  local stack), so not wired to PR events — PR smoke gating needs a
  self-hosted runner with a live stack. Full install-and-use matrix
  lives in `axonflow-enterprise/tests/e2e/plugin-batch-1/openclaw-install/`.

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

- **Reinstall after uninstall now works.** `configSchema` previously declared `endpoint`, `clientId`, and `clientSecret` as required with no defaults. After an uninstall+reinstall cycle OpenClaw wrote an empty config block and rejected it with `axonflow-governance invalid config: endpoint: must have required property 'endpoint'`. Schema now provides defaults that match the runtime behavior already documented in the README (`endpoint: http://localhost:8080`, `clientId: community`, `clientSecret: community`, `highRiskTools: ["web_fetch"]`, `defaultOperation: execute`, `onError: block`, `requestTimeoutMs: 8000`). User-provided values still take precedence over schema defaults.
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
