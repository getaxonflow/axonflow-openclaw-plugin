# @axonflow/openclaw-plugin

**Governance, security, and compliance plugin for [OpenClaw](https://github.com/openclaw/openclaw).** Protects against the top OpenClaw security risks: reverse shells via exec tool, data exfiltration via web_fetch, PII leakage in outbound messages, credential exposure, prompt injection, and outbound message exfiltration.

Built in response to real-world incidents including [CVE-2026-25253](https://nvd.nist.gov/vuln/detail/CVE-2026-25253) (CVSS 8.8), [CVE-2026-33573](https://nvd.nist.gov/vuln/detail/CVE-2026-33573) (workspace boundary bypass), the [ClawHavoc supply chain attack](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) (1,184 malicious skills), and [Microsoft's security advisory](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/) recommending VM isolation for all OpenClaw deployments.

AxonFlow adds the governance layer that OpenClaw's local safety controls don't cover: centralized policy enforcement for tool inputs, PII/secrets scanning and redaction on outbound messages, audit trails with decision context, and enterprise compliance evidence.

## What It Does

| Hook | When | Action |
|------|------|--------|
| `before_tool_call` | Before tool executes | Evaluates tool arguments against policies. Blocks dangerous commands, detects PII, enforces rate limits. |
| `after_tool_call` | After tool executes | Logs tool execution to AxonFlow audit trail. Fire-and-forget (non-blocking). |
| `message_sending` | Before message reaches user | Scans outbound messages for PII/secrets. Can cancel or redact before delivery to Telegram/Discord/Slack. |
| `llm_input` | Before LLM call | Records prompt, model, and provider to AxonFlow audit trail. |
| `llm_output` | After LLM response | Records response, token usage, and latency. Correlates with `llm_input` for complete audit entries. |

### Known Limitation: Tool Result Scanning

OpenClaw's `tool_result_persist` hook is synchronous, which means it cannot make async HTTP calls to AxonFlow for policy evaluation. Tool results written to the session transcript are **not** scanned for PII/secrets by this plugin.

**What IS protected:** Tool inputs are governed before execution (`before_tool_call`), and outbound messages to users are scanned before delivery (`message_sending`). LLM calls are audited.

**What is NOT protected:** Tool results entering the LLM context window via the session transcript are not scanned. If a tool returns PII, it will be visible to the LLM but will be caught before reaching the end user via `message_sending`.

We have filed an upstream request for async `tool_result_persist` support. When available, this plugin will add output scanning immediately.

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
