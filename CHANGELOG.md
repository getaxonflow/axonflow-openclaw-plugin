# Changelog

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
