# free-tier-minute-limit: runtime E2E

**Asserts**, by driving the plugin's real compiled client (`dist/axonflow-client.js`: `callMCPTool`, the helper behind the plugin's AxonFlow agent tools such as `axonflow_list_pro_features`) against a real local AxonFlow stack in Community SaaS mode, with no mocks, stubs or recorded responses:

1. **Under the Free per-minute limit, the tool calls succeed** (kind `ok`) for a freshly registered Free tenant.
2. **Over the limit, the call never comes back as a successful tool result.** It returns kind `envelope`: the upgrade prompt reaches the plugin's logger (`[AxonFlow] Upgrade: ...`) and the back-off is stamped.
3. **While the back-off holds, the next call is answered locally** (kind `throttled`).

The limit is reached by the client's own MCP calls; each call runs `initialize` and then `tools/call`.

## The platform side

getaxonflow/axonflow-enterprise#4261 makes the MCP route answer the per-minute limit as an HTTP 429 whose JSON-RPC result carries the upgrade envelope with `limit_type` `per_minute` and `Retry-After: 60`. Before the fix this leg ships with, the plugin did not recognise `per_minute`, so that answer would have reached the agent as a successful tool result; `tests/mcp-tool-per-minute-limit.test.ts` pins that shape. Until #4261 lands, the route answers the per-minute limit with the daily-quota envelope in a result flagged `isError`. This leg asserts the envelope either way, and prints the answer it saw on an `OBSERVED:` line without depending on it.

## Prerequisites

`node`, `curl` and `jq` on PATH, and a local stack in Community SaaS mode:

    docker compose -f docker-compose.yml -f docker-compose.community-saas.yml up -d

The leg builds `dist/` with `npm run build` when it is missing. It skips cleanly when the endpoint is unreachable, or when `/api/v1/register` answers 404 (a stack that is not in Community SaaS mode). Each run registers one tenant, and the registration route is rate limited per IP.

## Run

    AXONFLOW_ENDPOINT=http://localhost:8080 bash runtime-e2e/free-tier-minute-limit/test.sh

`AXONFLOW_E2E_EVIDENCE_DIR` keeps the driver, its result (every call's kind, the envelope's `limit_type`, the logger lines) and the back-off cache (default: a new temporary directory, printed at the start). `AXONFLOW_E2E_CAP_MAX_CALLS` bounds the calls made to reach the limit (default 60). The tenant's secret reaches the driver through its environment only, and is never printed or written to disk.
