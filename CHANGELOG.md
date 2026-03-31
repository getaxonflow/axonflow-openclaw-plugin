# Changelog

## [0.1.0] - 2026-04-01

### Added

- `before_tool_call` hook: evaluates tool arguments against AxonFlow policies before execution. Blocks dangerous commands, detects PII in tool input, enforces rate limits.
- `after_tool_call` hook: logs every tool execution to AxonFlow's audit trail for compliance evidence.
- `message_sending` hook: scans outbound messages to user channels (Telegram, Discord, Slack, WhatsApp) for PII and secrets. Can cancel or redact before delivery.
- `llm_input` hook: records prompt, model, and provider at the start of each LLM call to AxonFlow's audit trail.
- `llm_output` hook: records LLM response, token usage, and latency. Correlates with `llm_input` for complete LLM call audit entries.

### Not Yet Supported

- Tool result transcript scanning: OpenClaw's `tool_result_persist` hook is sync-only, preventing async HTTP calls to AxonFlow. Upstream issue filed (openclaw/openclaw#58558). Outbound messages ARE scanned via `message_sending`.
- High-risk tool approval: configurable tool list triggers OpenClaw's native approval flow (Telegram/Discord/approve command) even when AxonFlow allows the call.
- Configurable governance scope: govern all tools, specific tools only, or exclude specific tools.
- Starter policy documentation with SQL setup for OpenClaw production baseline.
