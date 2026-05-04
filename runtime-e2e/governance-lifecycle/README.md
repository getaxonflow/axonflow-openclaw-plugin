# governance-lifecycle — runtime E2E

**Asserts:** Chains audit-search + list-overrides in a single agent session — proves the W2 features cohere. Full create→list→explain→revoke→list lifecycle gated on AXONFLOW_LICENSE.

**Prereqs:** runtime CLI on PATH and authenticated; `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/governance-lifecycle/test.sh
```
