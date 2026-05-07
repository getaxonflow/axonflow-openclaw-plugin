# Runtime E2E — V1 Plugin Pro proxy tools (OpenClaw)

Verifies that the four V1 Plugin Pro proxy tools registered locally in
the OpenClaw plugin actually round-trip to the agent's
`/api/v1/mcp-server` and return the locked V1 shapes.

Tools under test:

- `axonflow_list_pro_features` — Free + Pro accessible. Pure data
  tool; returns 5 differentiators + $9.99 / 90-day pricing.
- `axonflow_get_cost_estimate` — Pro-only. On Free tier the agent
  returns the V1 envelope `limit_type=feature_pro_only`; the proxy
  surfaces the wording back to the agent as a `fail()` result and
  stamps the throttle file.
- `axonflow_request_approval` — exercised by the unit suite (graduated
  cap is HITL-state-dependent; not driven from prod).
- `axonflow_create_tenant_policy` — exercised by the unit suite (would
  pollute the synthetic tenant's policy table; not driven from prod).

## Why these proxies exist

OpenClaw is the architectural exception in S3: it does NOT
auto-discover the agent's MCP `tools/list`, so the 5 V1 Pro tools that
flow into claude / cursor / codex automatically need explicit
registration here. `axonflow_get_tenant_id` is registered as a local
in-process tool (no agent round-trip required — the answer comes from
local plugin state). The other 4 wrap server-side state, so they
proxy to the agent's MCP server via a single `callMCPTool(name, args)`
helper on `AxonFlowClient`.

## Steps

1. Build `dist/agent-tools.js` + `dist/axonflow-client.js` via
   `npm run build` if needed.
2. Register a fresh Free-tier tenant via `POST /api/v1/register`
   (synth label `v1-pro-proxy-tools-e2e`).
3. Spawn a Node driver that:
   - Constructs an `AxonFlowClient` with the test credentials.
   - Wires a logger via `setUpgradePromptLogger`.
   - Calls `buildAgentTools({ current: client })` and invokes:
     - `axonflow_list_pro_features.execute()` — expect Free-accessible
       success with 5 differentiators + $9.99 pricing.
     - `axonflow_get_cost_estimate.execute({plan: ...})` — expect
       envelope-shaped fail with `limit_type=feature_pro_only`.
4. Assert:
   - `list_pro_features` returned `isError=false` with the locked V1
     shape (`differentiators.length === 5`, `pricing.price_usd === 9.99`).
   - `get_cost_estimate` returned `isError=true` with
     `details.limit_type === "feature_pro_only"` and
     `details.buy_url` matching the locked V1 URL.
   - The upgrade-prompt logger received the locked wording on stderr.
   - `${AXONFLOW_CACHE_DIR}/throttle-until` is stamped.

## Skip conditions

- `node` / `jq` / `curl` missing → SKIP.
- `${AGENT_URL}/health` not reachable → SKIP.
- Tenant registration HTTP code other than 200/201 (e.g. 429 from the
  per-IP rate limiter) → SKIP.

## Usage

```bash
AGENT_URL=https://try.getaxonflow.com bash runtime-e2e/v1_pro_proxy_tools/test.sh
```

Evidence under `runtime-e2e/v1_pro_proxy_tools/EVIDENCE/<utc-ts>/`:

- `register.json` — register response (tenant_id + secret)
- `driver.cjs` — Node driver source committed alongside the run
- `driver_out.json` — full output from both tool invocations
- `driver.log` — stderr from the driver (logger output lands here)
- `throttle-until.txt` — copy of the stamped back-off file
- `summary.txt` — top-line PASS / FAIL line

## Cross-references

- Tool builders: `src/agent-tools.ts` —
  `buildRequestApprovalTool`, `buildCreateTenantPolicyTool`,
  `buildGetCostEstimateTool`, `buildListProFeaturesTool`
- MCP proxy helper: `src/axonflow-client.ts` — `callMCPTool(name, args)`
- Agent-side tool definitions: `axonflow-enterprise/platform/agent/mcp_v1_pro_tools.go`
- Doctrine: `feedback_runtime_proof_is_definition_of_done.md`
- Umbrella: `axonflow-enterprise#1958`, sub-issue `axonflow-enterprise#1965`
