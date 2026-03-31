# @axonflow/openclaw

**Policy enforcement, approval gates, and audit trails for [OpenClaw](https://github.com/openclaw/openclaw).**

OpenClaw handles agent runtime, tool execution, MCP connectivity, and channel delivery. AxonFlow adds a governance layer for production use: inspect tool inputs before execution, scan outbound messages before delivery, and record tool + LLM activity for review, security, and compliance.

This plugin is useful when you want to:
- block dangerous tool calls before they run
- require approval for selected high-risk tools
- prevent PII or secrets from being sent to users
- keep an audit trail of agent activity with policy context

Much of the OpenClaw ecosystem today focuses on routing, memory, integrations, and observability. This plugin focuses on governance: policy enforcement, approval gates, and reviewable audit trails.

## What v0.1.0 Covers

| Hook | Purpose |
|------|---------|
| `before_tool_call` | Evaluate tool inputs against AxonFlow policies before execution |
| `after_tool_call` | Record tool execution in AxonFlow audit trail |
| `message_sending` | Scan outbound messages for PII/secrets before delivery |
| `llm_input` | Record prompt, model, and provider for audit |
| `llm_output` | Record response summary, token usage, and latency for audit |

## Current Limitation

Tool results written into the OpenClaw session transcript are not yet scanned by this plugin. OpenClaw's `tool_result_persist` hook is synchronous today, so it cannot call AxonFlow's HTTP policy APIs.

What is protected today:
- tool inputs before execution
- outbound messages before delivery
- tool and LLM audit trails

What is not protected yet:
- tool results entering the LLM context through the session transcript

If OpenClaw adds async support for `tool_result_persist`, AxonFlow can add transcript/result scanning immediately. Upstream issue: [openclaw/openclaw#58558](https://github.com/openclaw/openclaw/issues/58558).

## Install

```bash
openclaw plugins install @axonflow/openclaw
```

## Configure

In your OpenClaw config:

```yaml
plugins:
  @axonflow/openclaw:
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
| `onError` | No | `"block"` | Behavior when AxonFlow is unreachable: `"block"` (fail-closed) or `"allow"` (fail-open) |

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
Tool result persisted to session transcript
(not scanned — pending async hook support)
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
│ → mcp_check_output(openclaw.message_sending) │
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

See [policies/README.md](./policies/README.md) for recommended policy setup for OpenClaw deployments, including protections against reverse shells, credential exfiltration, SSRF, path traversal, and agent config file poisoning.

## Links

- [AxonFlow Documentation](https://docs.getaxonflow.com)
- [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/)
- [Policy Enforcement](https://docs.getaxonflow.com/docs/mcp/policy-enforcement/)

## License

MIT
