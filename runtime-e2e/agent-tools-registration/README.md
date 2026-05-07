# Runtime E2E — agent-tools registration (`axonflow_get_tenant_id`)

Verifies that the new V1 Plugin Pro agent-tool `axonflow_get_tenant_id`
is registered in the OpenClaw plugin's `buildAgentTools()` array AND
that calling its `execute()` actually invokes the `buildStatusReport`
code path (returning a real StatusReport-shaped payload, not a stubbed
shape that just looks right at registration time).

## Why this test

OpenClaw is the architectural exception in S3: the other plugin hosts
(Claude / Cursor / Codex) auto-discover the 5 V1 Pro MCP tools via the
agent's `/api/v1/mcp-server` `tools/list`. OpenClaw doesn't proxy that
endpoint — it loads tool definitions locally via
`api.registerTool(...)` at plugin init. So `axonflow_get_tenant_id`
needs explicit code-level registration, and the registration test is the
runtime proof that the code change actually landed.

This mirrors the existing `runtime-e2e/status-cli-url/` pattern from
PR #104 (which proved the status URL change actually fired in the
plugin runtime, not just in unit tests).

## Steps

1. Build `dist/agent-tools.js` via `npm run build` if needed.
2. Spawn a Node driver that requires the compiled module + invokes
   `buildAgentTools({ current: {} })` with a stub clientRef.
3. Assert the returned array contains exactly 6 tools — the original 5
   plus the new `axonflow_get_tenant_id`.
4. Invoke `getTenantIdTool.execute("test-call-id-1", {})` against a
   hermetic empty `AXONFLOW_CACHE_DIR` + `AXONFLOW_CONFIG_DIR`.
5. Assert the resolved result has `details.{tier, endpoint, upgrade_url,
   buy_url}` set to the locked V1 values.

## Skip conditions

- `node` or `jq` missing → SKIP.

## Usage

```bash
bash runtime-e2e/agent-tools-registration/test.sh
```

Evidence under `runtime-e2e/agent-tools-registration/EVIDENCE/<utc-ts>/`:

- `driver.cjs` — Node driver source committed alongside the run
- `driver_out.json` — full driver output (registered tool names, the
  parameters schema, the resolved `execute()` result)
- `summary.txt` — top-line PASS / FAIL line

## Cross-references

- New tool source: `src/agent-tools.ts` — `buildGetTenantIdTool()`
- Status report builder: `src/status.ts` — `buildStatusReport()`,
  `resolveStatusInputs()`
- Sister test: `runtime-e2e/status-cli-url/` (same pattern: assert a
  registration-time change actually fires in the plugin runtime)
- Doctrine: `feedback_runtime_proof_is_definition_of_done.md`
- Umbrella: `axonflow-enterprise#1958`, sub-issue `axonflow-enterprise#1965`
