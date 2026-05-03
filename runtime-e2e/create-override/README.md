# create-override — runtime E2E

**Asserts:** Drives the runtime to dispatch create_override against a non-override-able policy; verifies dispatch (community-mode platform may accept or reject — both are runtime-path successes).

**Prereqs:** runtime CLI on PATH and authenticated; `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/create-override/test.sh
```
