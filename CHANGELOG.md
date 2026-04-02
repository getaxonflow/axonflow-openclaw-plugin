# Changelog

## [Unreleased]

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
- **Usage telemetry**: Anonymous checkpoint ping on initialization reporting SDK version, platform info, and hook configuration. Respects `DO_NOT_TRACK=1` and `AXONFLOW_TELEMETRY=off`. Suppressed for localhost endpoints.
- Starter policy documentation with SQL setup for OpenClaw production baseline.

### Not Yet Supported

- Tool result transcript scanning: OpenClaw's `tool_result_persist` hook is sync-only, preventing async HTTP calls to AxonFlow. Upstream issue filed (openclaw/openclaw#58558). Outbound messages ARE scanned via `message_sending`.
