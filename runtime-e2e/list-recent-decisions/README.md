# list-recent-decisions — runtime-e2e

V1.1 decision-list (axonflow-enterprise#1982). Asserts the OpenClaw plugin can drive `axonflow_list_recent_decisions` against a live AxonFlow stack:

1. Plugin builds + installs into OpenClaw without errors.
2. The platform's MCP server advertises `list_recent_decisions` (cross-checked via `tools/list`).
3. The agent-tool wrapper is dispatchable end-to-end (registered, callable via OpenClaw's tool router).
4. Happy-path tool call returns a `decisions` array (possibly empty on a fresh DB; that's fine — the assertion is on the response shape).
5. Free-tier cap-hit (`limit=10` exceeds Community max page=5) returns the V1 upgrade envelope with `upgrade.compare_url` + `upgrade.buy_url` intact — locks in `feedback_429_no_upgrade_hint_is_conversion_gap.md`.

**Prereqs:** `openclaw` CLI on PATH, `jq`, live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Run:**

```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
AXONFLOW_CLIENT_ID=demo-client \
AXONFLOW_CLIENT_SECRET=demo-secret \
  bash runtime-e2e/list-recent-decisions/test.sh
```

The test gracefully `SKIP`s if the stack or `openclaw` CLI is unavailable.
