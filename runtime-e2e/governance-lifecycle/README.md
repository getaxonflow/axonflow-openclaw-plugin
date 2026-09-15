# governance-lifecycle: runtime E2E

**Asserts** the W2 governance read path on AxonFlow v11.0.0, chained in one agent session. Session overrides are retired from v11.0.0, so the create, list, revoke, list lifecycle this suite used to drive no longer exists; what remains is:

1. **The write is retired** on the platform (HTTP 409 `LEGACY_POLICY_WRITE_FROZEN`, via `require_override_write_frozen`).
2. **The read path runs:** the runtime dispatches `axonflow_list_overrides` and `axonflow_audit_search`, read from its own tool summary.
3. **The writes are not offered:** the runtime dispatches neither `axonflow_create_override` nor `axonflow_revoke_override`.
4. **The numbers are the platform's:** the override count the agent read equals `GET /api/v1/overrides`, and the audit search returned a numeric entry count.

**Prereqs:** the `openclaw` CLI on PATH, on a Node version it accepts (OpenClaw 2026.7.1-2 needs Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0); `jq`; a live AxonFlow v11.0.0 or later stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Required deployment posture:** the retirement probe carries a per-user identity, which the AxonFlow **agent** strips unless `AXONFLOW_TRUST_IDENTITY_HEADERS=true` is set on it (default off since 9.9.0); without it the probe answers 401 and this test **fails** with the remediation printed. Only enable it when every hop that can reach the agent asserts end-user identity from a validated source; see `docs/security/identity-header-trust.md` in axonflow-enterprise.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/governance-lifecycle/test.sh
```
