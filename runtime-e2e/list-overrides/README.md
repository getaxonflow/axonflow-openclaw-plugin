# list-overrides — runtime E2E

**Asserts:** Drives the runtime to dispatch list_overrides; agent reports the count via SMOKE_RESULT.

**Prereqs:** runtime CLI on PATH and authenticated; `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/list-overrides/test.sh
```
