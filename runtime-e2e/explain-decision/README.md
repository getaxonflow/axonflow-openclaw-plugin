# explain-decision — runtime E2E

**Asserts:** Drives the runtime to dispatch explain_decision against a fabricated decision_id; platform returns 404 and agent surfaces the not-found result via SMOKE_RESULT marker.

**Prereqs:** runtime CLI on PATH and authenticated; `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/explain-decision/test.sh
```
