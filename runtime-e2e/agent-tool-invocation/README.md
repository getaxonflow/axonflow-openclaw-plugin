# agent-tool-invocation

Proves that AxonFlow agent tools are **visible and callable** through
the OpenClaw plugin host — not just registered at the API level.

## What it asserts

1. `openclaw agent --local --json` can call `axonflow_get_tenant_id`
2. The agent's reply contains a tenant_id value (not "tool not found")
3. `openclaw plugins doctor` reports zero diagnostics for axonflow-governance

## Prereqs

- `openclaw` CLI on `$PATH`
- `ANTHROPIC_API_KEY` or authenticated Anthropic profile (uses claude-haiku-4-5)
- Plugin built locally (`npm run build`)

## Run

```bash
AXONFLOW_TELEMETRY=off bash runtime-e2e/agent-tool-invocation/test.sh
```

## Why this exists

v2.6.4 incident: the plugin logged "Registered 11 agent-callable tools"
but the manifest lacked `contracts.tools`, so OpenClaw never surfaced
them to the LLM. The existing `agent-tools-registration` test caught
registration via direct Node import but not the host-level surfacing.
