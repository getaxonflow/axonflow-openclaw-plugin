# @axonflow/openclaw

**Policy enforcement, approval gates, and audit trails for [OpenClaw](https://github.com/openclaw/openclaw).**

## Why

OpenClaw is widely deployed with [13+ CVEs disclosed in 2026](https://github.com/jgamblin/OpenClawCVEs/) (multiple CVSS 9.8+), [135,000+ publicly exposed instances](https://www.bitsight.com/blog/openclaw-ai-security-risks-exposed-instances), and [1,184 malicious skills](https://cyberpress.org/clawhavoc-poisons-openclaws-clawhub-with-1184-malicious-skills/) poisoned in ClawHub via the ClawHavoc supply chain attack. OpenClaw provides agent runtime and tool execution but no centralized policy enforcement, no PII scanning, and no compliance-grade audit trails.

This plugin adds the governance layer. AxonFlow governs, OpenClaw orchestrates. No LLM provider keys needed — OpenClaw handles all LLM calls, AxonFlow only enforces policies and records audit trails. Your data stays on your infrastructure.

This plugin is useful when you want to:
- block dangerous tool calls (reverse shells, SSRF, destructive commands) before they run
- detect and redact PII and secrets in outbound messages before delivery
- require human approval for high-risk tools (exec, web_fetch, message)
- keep a compliance-grade audit trail of every tool call and LLM interaction
- gain visibility into token usage and LLM activity across agents via audit trails

## What It Does

| Hook | Purpose |
|------|---------|
| `before_tool_call` | Evaluate tool inputs against AxonFlow policies before execution |
| `after_tool_call` | Record tool execution in AxonFlow audit trail |
| `message_sending` | Scan outbound messages for PII/secrets before delivery |
| `llm_input` | Record prompt, model, and provider for audit |
| `llm_output` | Record response summary, token usage, and latency for audit |

The plugin also:
- **Verifies AxonFlow connectivity** on startup and logs a warning if unreachable
- **Tracks governance metrics** in-process (tool calls blocked/allowed, messages redacted, etc.) accessible via `getMetrics()`

## Current Limitation

Tool results written into the OpenClaw session transcript are not yet scanned by this plugin. OpenClaw's `tool_result_persist` hook is synchronous today, so it cannot call AxonFlow's HTTP policy APIs.

What is protected today:
- tool inputs before execution
- outbound messages before delivery
- tool and LLM audit trails

What is not protected yet:
- tool results entering the LLM context through the session transcript

If OpenClaw adds async support for `tool_result_persist`, AxonFlow can add transcript/result scanning immediately. Upstream issue: [openclaw/openclaw#58558](https://github.com/openclaw/openclaw/issues/58558).

## Prerequisites

This plugin connects to [AxonFlow](https://github.com/getaxonflow/axonflow), a self-hosted governance platform, for policy evaluation and audit logging. AxonFlow must be running before you use the plugin. Your data stays on your infrastructure.

```bash
# Start AxonFlow (Docker — runs entirely on your machine)
git clone https://github.com/getaxonflow/axonflow.git
cd axonflow
docker compose up -d
```

See [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) for full setup options.

## Install

Available on [ClawHub](https://clawhub.ai/plugins/%40axonflow%2Fopenclaw) and [npm](https://www.npmjs.com/package/@axonflow/openclaw).

```bash
openclaw plugins install @axonflow/openclaw
```

> ⚠️ **Known issue with scoped packages on OpenClaw CLI**
>
> If the command above fails with `ENOENT: no such file or directory, open '...openclaw-clawhub-package-XXXXXX/@axonflow/openclaw.zip'`, this is an upstream OpenClaw CLI bug ([openclaw/openclaw#66618](https://github.com/openclaw/openclaw/issues/66618)) affecting all scoped npm packages (any name with `@scope/`). The CLI writes the downloaded zip to a path containing the scope as a subdirectory but never creates that subdirectory. Workaround — install from npm directly:
>
> ```bash
> # Captures the exact tgz filename so a stale tgz in CWD doesn't get picked up
> TGZ=$(npm pack @axonflow/openclaw 2>/dev/null | tail -1)
> openclaw plugins install "./$TGZ"
> ```

For the full integration walkthrough (architecture, hook coverage, policy examples, troubleshooting), see the [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/).

## Configure

In your OpenClaw config:

```yaml
plugins:
  @axonflow/openclaw:
    endpoint: http://localhost:8080
    # In community mode, clientId defaults to "community"
    # and clientSecret can be left unset.
    # Set both only for evaluation/enterprise credentials.
    # clientId: your-client-id
    # clientSecret: your-client-secret
    # requestTimeoutMs: 8000
    highRiskTools:
      - web_fetch
      - message
```

### Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `endpoint` | Yes | — | AxonFlow agent gateway URL |
| `clientId` | No | `"community"` | Tenant identity for data isolation. Override for evaluation/enterprise. |
| `clientSecret` | No | `""` | License key for evaluation/enterprise features. Requires `clientId` to be set. |
| `highRiskTools` | No | `[]` | Tools that require human approval even when policy allows |
| `governedTools` | No | `[]` (all) | Tools to govern. Empty = all tools. |
| `excludedTools` | No | `[]` | Tools to exclude from governance |
| `defaultOperation` | No | `"execute"` | Operation type for mcp_check_input (`"execute"` or `"query"`) |
| `onError` | No | `"block"` | Behavior when AxonFlow is unreachable: `"block"` (fail-closed) or `"allow"` (fail-open) |
| `requestTimeoutMs` | No | `8000` | Timeout for policy checks, output scans, audit writes, and health checks. Increase for remote AxonFlow deployments. |

**Valid configurations:**
- Both omitted → community mode (`clientId` defaults to `"community"`)
- `clientId` only → community mode with custom tenant identity
- Both set → licensed mode (evaluation/enterprise)
- `clientSecret` only → **error** (licensed mode requires explicit tenant identity to prevent data going to the wrong tenant)

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

## Telemetry

This plugin sends an anonymous telemetry ping on initialization to help us understand usage patterns, including local and self-hosted evaluations. The ping includes: plugin version, platform info (OS, architecture, Node.js version), AxonFlow platform version, and hook configuration (count, onError mode). No PII, no tool arguments, no policy data.

Opt out:
- `DO_NOT_TRACK=1` (standard)
- `AXONFLOW_TELEMETRY=off`

The startup ping is enabled by default for local, self-hosted, and remote deployments. Opt-out controls always win.

## Starter Policies

See [policies/README.md](./policies/README.md) for recommended policy setup for OpenClaw deployments, including protections against reverse shells, credential exfiltration, SSRF, path traversal, and agent config file poisoning.

## Links

- [AxonFlow Documentation](https://docs.getaxonflow.com)
- [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/)
- [Policy Enforcement](https://docs.getaxonflow.com/docs/mcp/policy-enforcement/)

## License

MIT
