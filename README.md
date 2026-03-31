# @axonflow/openclaw-plugin

AxonFlow governance plugin for [OpenClaw](https://github.com/openclaw/openclaw). Adds centralized policy enforcement, PII detection, and audit trails to OpenClaw tool execution.

## What It Does

| Hook | When | Action |
|------|------|--------|
| `before_tool_call` | Before tool executes | Evaluates tool arguments against policies. Blocks dangerous commands, detects PII, enforces rate limits. |
| `tool_result_persist` | Before result is saved | Scans tool output for PII/secrets. Redacts sensitive data before it reaches the session transcript. |
| `after_tool_call` | After tool executes | Logs tool execution to AxonFlow audit trail. Fire-and-forget (non-blocking). |
| `message_sending` | Before message reaches user | Scans outbound messages for PII/secrets. Can cancel or redact before delivery to Telegram/Discord/Slack. |
| `llm_input` | Before LLM call | Records prompt, model, and provider to AxonFlow audit trail. |
| `llm_output` | After LLM response | Records response, token usage, and latency. Correlates with `llm_input` for complete audit entries. |

## Install

```bash
openclaw plugins install @axonflow/openclaw-plugin
```

## Configure

In your OpenClaw config:

```yaml
plugins:
  @axonflow/openclaw-plugin:
    endpoint: http://localhost:8080
    clientId: your-client-id
    clientSecret: your-secret
    highRiskTools:
      - web_fetch
      - message
```

### Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `endpoint` | Yes | — | AxonFlow agent gateway URL |
| `clientId` | Yes | — | AxonFlow client ID |
| `clientSecret` | Yes | — | AxonFlow client secret |
| `highRiskTools` | No | `[]` | Tools that require human approval even when policy allows |
| `governedTools` | No | `[]` (all) | Tools to govern. Empty = all tools. |
| `excludedTools` | No | `[]` | Tools to exclude from governance |
| `defaultOperation` | No | `"execute"` | Operation type for mcp_check_input (`"execute"` or `"query"`) |

## How It Works

```
User sends message → OpenClaw receives
    │
    ▼
┌─────────────────────────────────────────────┐
│ llm_input (audit)                           │
│ → Record prompt, model, provider            │
└─────────────────────────────────────────────┘
    │
    ▼
LLM generates response (may include tool calls)
    │
    ▼
┌─────────────────────────────────────────────┐
│ llm_output (audit)                          │
│ → Record response, tokens, latency          │
└─────────────────────────────────────────────┘
    │
    ▼  (if tool calls in response)
┌─────────────────────────────────────────────┐
│ before_tool_call (governance)               │
│ → mcp_check_input(openclaw.{tool}, args)    │
│ → BLOCK / REQUIRE APPROVAL / ALLOW          │
└─────────────────────────────────────────────┘
    │
    ▼
Tool executes (web_fetch, message, MCP, etc.)
    │
    ▼
┌─────────────────────────────────────────────┐
│ tool_result_persist (governance)            │
│ → mcp_check_output(openclaw.{tool}, result) │
│ → REDACT PII/secrets / BLOCK / ALLOW        │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ after_tool_call (audit)                     │
│ → audit_tool_call(tool, params, result)     │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ message_sending (governance)                │
│ → mcp_check_output(openclaw.message, text)  │
│ → CANCEL / REDACT / ALLOW                   │
└─────────────────────────────────────────────┘
    │
    ▼
Message delivered to user channel
```

## Prerequisites

- [AxonFlow](https://github.com/getaxonflow/axonflow) running (Docker or production)
- OpenClaw 1.0+

## Starter Policies

See [policies/README.md](./policies/README.md) for recommended policy setup for OpenClaw deployments.

## Links

- [AxonFlow Documentation](https://docs.getaxonflow.com)
- [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/)
- [Policy Enforcement](https://docs.getaxonflow.com/docs/mcp/policy-enforcement/)

## License

MIT
