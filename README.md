# @axonflow/openclaw-plugin

AxonFlow governance plugin for [OpenClaw](https://github.com/openclaw/openclaw). Adds centralized policy enforcement, PII detection, and audit trails to OpenClaw tool execution.

## What It Does

| Hook | When | Action |
|------|------|--------|
| `before_tool_call` | Before tool executes | Evaluates tool arguments against policies. Blocks dangerous commands, detects PII, enforces rate limits. |
| `tool_result_persist` | Before result is saved | Scans tool output for PII/secrets. Redacts sensitive data before it reaches the session transcript. |
| `after_tool_call` | After tool executes | Logs execution to AxonFlow audit trail. Fire-and-forget (non-blocking). |

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
User sends message → OpenClaw selects tool
    │
    ▼
┌─────────────────────────────────────────────┐
│ before_tool_call (AxonFlow plugin)          │
│ → mcp_check_input(openclaw.{tool}, args)    │
│ → BLOCK if policy violated                  │
│ → REQUIRE APPROVAL if high-risk tool        │
│ → ALLOW if clean                            │
└─────────────────────────────────────────────┘
    │
    ▼
Tool executes (web_fetch, message, MCP, etc.)
    │
    ▼
┌─────────────────────────────────────────────┐
│ tool_result_persist (AxonFlow plugin)       │
│ → mcp_check_output(openclaw.{tool}, result) │
│ → REDACT PII/secrets in result              │
│ → BLOCK if exfiltration detected            │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ after_tool_call (AxonFlow plugin)           │
│ → audit_tool_call(tool, params, result)     │
│ → Non-blocking audit log                    │
└─────────────────────────────────────────────┘
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

BSL-1.1 (Business Source License)
