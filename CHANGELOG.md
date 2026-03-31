# Changelog

## [0.1.0] - 2026-03-31

### Added

- `before_tool_call` hook: evaluates tool arguments against AxonFlow policies before execution. Blocks dangerous commands, detects PII in tool input, enforces rate limits.
- `tool_result_persist` hook: scans tool results for PII and secrets. Redacts sensitive data before it reaches the session transcript.
- `after_tool_call` hook: logs every tool execution to AxonFlow's audit trail for compliance evidence.
- High-risk tool approval: configurable tool list triggers OpenClaw's native approval flow (Telegram/Discord/approve command) even when AxonFlow allows the call.
- Configurable governance scope: govern all tools, specific tools only, or exclude specific tools.
- Starter policy documentation with SQL setup for OpenClaw production baseline.
