# governance-lifecycle — runtime E2E

**Asserts:** Chains audit-search + list-overrides in a single agent session — proves the W2 features cohere. Full create→list→explain→revoke→list lifecycle gated on AXONFLOW_LICENSE.

**Prereqs:** runtime CLI on PATH and authenticated; `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`); the agent running with `AXONFLOW_TRUST_IDENTITY_HEADERS=true`.

**This test does not skip on a missing posture.** The override endpoints need a per-user identity, and since platform 9.9.0 the agent ignores `X-User-Email` unless the identity trust gate is on — so a healthy-looking default stack answers 401. Through v2.8.4 the pre-flight probe printed `SKIP:` and exited 0 on any non-201, which meant CI reported success in exactly the configuration every user runs and the lifecycle was never exercised (#167, axonflow-enterprise#3062). It now fails with the flag to set. The posture is server-side and cannot be provisioned from this harness.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/governance-lifecycle/test.sh
```
