# revoke-override — runtime E2E

**Asserts:** Drives the runtime to dispatch delete_override (server-side name) with a fabricated override_id; platform returns 404 and agent surfaces it.

**Prereqs:** runtime CLI on PATH and authenticated; `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/revoke-override/test.sh
```
