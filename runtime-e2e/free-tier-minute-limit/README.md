# free-tier-minute-limit: runtime E2E

**Asserts**, by driving the plugin's real compiled client (`dist/axonflow-client.js`: `callMCPTool`, the helper behind the plugin's AxonFlow agent tools such as `axonflow_list_pro_features`) against a real local AxonFlow stack in Community SaaS mode, with no mocks, stubs or recorded responses:

1. **Under the Free per-minute limit, the tool calls succeed** (kind `ok`) for a freshly registered Free tenant.
2. **Every answer that carries the limit's envelope comes back as kind `envelope`**: never kind `ok` with the envelope handed to the agent as the tool's result, and never a bare error.
3. **The tier-check path:** when `tools/call` is answered with the limit, the call returns kind `envelope` with the upgrade prompt (`[AxonFlow] Upgrade: ...` on the plugin's logger), the back-off is stamped, and the next call is answered locally (kind `throttled`).
4. **The pre-credential path:** when `initialize` itself is refused, the call is refused, never kind `ok`. When that refusal carries the limit's envelope, an isolated probe returns kind `envelope` with the upgrade prompt and its own back-off stamped.

`callMCPTool` runs `initialize` and then `tools/call`, so the limit can answer on either request. The leg reaches the tier-check path first. It then sends concurrent batches, each call pointed at a fresh cache directory so the local back-off does not answer, until `initialize` itself is refused. Those calls share one process environment and the plugin reads its cache directory after its awaits, so they are not isolated from each other, and the leg asserts only their kinds. It then sends one isolated probe, alone, with its own cache directory, and asserts the pre-credential path's prompt and back-off on that probe. A pass-through recorder notes each real response's JSON-RPC method, HTTP status and whether its body is the limit's envelope; it changes nothing on the wire.

## The platform side

getaxonflow/axonflow-enterprise#4261 makes the MCP route answer the per-minute limit the same way on both paths: HTTP 429, `Retry-After: 60`, and a JSON-RPC result flagged `isError` whose text is the upgrade envelope with `limit_type` `per_minute`. Before the fix this leg ships with, the plugin did not recognise `per_minute`: the tier-check answer would have reached the agent as a successful tool result, and the pre-credential answer as a bare "MCP initialize returned no session-id (HTTP 429)". `tests/mcp-tool-per-minute-limit.test.ts` pins both of #4261's answers.

Until #4261 lands, the tier check answers with the daily-quota envelope in a result flagged `isError`, and the pre-credential check refuses `initialize` without an envelope, so there is no prompt to show on that path. The leg asserts what the plugin controls either way, and prints each path's actual answer on an `OBSERVED:` line.

## Prerequisites

`node`, `curl` and `jq` on PATH, and a local stack in Community SaaS mode:

    docker compose -f docker-compose.yml -f docker-compose.community-saas.yml up -d

The leg builds `dist/` with `npm run build` when it is missing. It skips cleanly when the endpoint is unreachable, or when `/api/v1/register` answers 404 (a stack that is not in Community SaaS mode). Each run registers one tenant, and the registration route is rate limited per IP.

## Run

    AXONFLOW_ENDPOINT=http://localhost:8080 bash runtime-e2e/free-tier-minute-limit/test.sh

`AXONFLOW_E2E_EVIDENCE_DIR` keeps the driver and its result: every call's kind, each request's method, status and envelope, and which calls showed the prompt (default: a new temporary directory, printed at the start). `AXONFLOW_E2E_CAP_MAX_CALLS` bounds the first phase (default 60), `AXONFLOW_E2E_PRECRED_MAX_CALLS` the second (default 400), and `AXONFLOW_E2E_BATCH` sets its concurrency (default 10). The tenant's secret reaches the driver through its environment only, and is never printed or written to disk.
