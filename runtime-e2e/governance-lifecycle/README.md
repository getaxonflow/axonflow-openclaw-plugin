# governance-lifecycle — runtime E2E

**Asserts:** Chains audit-search + list-overrides in a single agent session — proves the W2 features cohere. Full create→list→explain→revoke→list lifecycle gated on AXONFLOW_LICENSE.

**Prereqs:** runtime CLI on PATH and authenticated; `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`); the deployment posture below.

**Required deployment posture:** the override endpoints are scoped to an individual user, so the AxonFlow **agent** must be forwarding a per-user identity. On a default deployment it is not: `AXONFLOW_TRUST_IDENTITY_HEADERS` defaults to **off** (since 9.9.0) and the agent strips `X-User-Email`, so `create_override` returns 401 and this test **fails** with the remediation printed (it used to skip silently and report green — #3062).

```bash
AXONFLOW_TRUST_IDENTITY_HEADERS=true   # on the AGENT, then restart it
```

Only enable it when every hop that can reach the agent asserts end-user identity from a validated source — see `docs/security/identity-header-trust.md` in axonflow-enterprise.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/governance-lifecycle/test.sh
```
