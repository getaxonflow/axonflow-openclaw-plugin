# caller-name-audit

Proves that `auditToolCall()`'s `caller_name` field (getaxonflow/axonflow-enterprise#2912)
reaches `audit_logs.policy_details` end-to-end through a **real OpenClaw tool
dispatch** — not a mocked HTTP call.

## What it asserts

1. `openclaw agent --local --json` calls the real `axonflow_get_tenant_id`
   tool, which fires the plugin's `after_tool_call` hook and invokes the
   compiled `auditToolCall()` against a live AxonFlow stack.
2. The resulting `audit_logs` row (read directly from Postgres) has
   `policy_details->>'caller_name' = 'openclaw'`.
3. `policy_details ? 'tool_type'` is **false** — the platform (#2953) no
   longer writes the deprecated `tool_type` key for new rows.

## Prereqs

- `openclaw` CLI on `$PATH`; `jq`
- Live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (defaults to
  `http://localhost:8080`)
- An LLM provider authenticated for OpenClaw (default
  `anthropic/claude-haiku-4-5`, override via `OPENCLAW_E2E_MODEL`)
- Postgres access to the same stack, via either:
  - `psql` on `$PATH` + `$AXONFLOW_DB_URL` (defaults to
    `postgresql://axonflow:localdev123@localhost:5432/axonflow`, matching
    `axonflow-enterprise/docker-compose.yml`'s default local-dev credentials), or
  - `docker exec` into `$AXONFLOW_DB_CONTAINER` (defaults to
    `axonflow-postgres`, the compose `container_name` for the same stack)

  Missing both → the test SKIPs cleanly rather than failing.

## Run

```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
AXONFLOW_CLIENT_ID=demo-client \
AXONFLOW_CLIENT_SECRET=demo-secret \
  bash runtime-e2e/caller-name-audit/test.sh
```

## Why this exists

PR #156 switched `auditToolCall()`'s payload field from `tool_type` to
`caller_name` (the platform's `tool_type` field was misleadingly named —
it identified the calling client, not a tool kind). `tests/axonflow-client.test.ts`
already unit-tests the payload shape with a mocked `fetch`, but per this
directory's charter that only proves the client *sends* the right bytes,
not that a real OpenClaw dispatch produces a real, correctly-shaped
`audit_logs` row on a live platform. This test closes that gap.
