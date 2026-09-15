# revoke-override: runtime E2E

**Asserts** that the override delete is retired from AxonFlow v11.0.0 and that the plugin no longer offers it:

1. **The platform.** `DELETE /api/v1/overrides/<id>` with a per-user identity answers HTTP 409 with the code `LEGACY_POLICY_WRITE_FROZEN`, whatever the id (`require_override_write_frozen`, which fails on any other answer and never skips).
2. **The plugin.** A real OpenClaw agent turn dispatches `axonflow_get_tenant_id` (the control) and never dispatches `axonflow_revoke_override`, read from the runtime's own tool summary.

**Prereqs:** the `openclaw` CLI on PATH, on a Node version it accepts (OpenClaw 2026.7.1-2 needs Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0); `jq`; a live AxonFlow v11.0.0 or later stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Required deployment posture:** the override endpoints are scoped to an individual user, so the AxonFlow **agent** must forward a per-user identity for the delete to reach its retirement check. On a default deployment it does not: `AXONFLOW_TRUST_IDENTITY_HEADERS` defaults to **off** (since 9.9.0) and the agent strips `X-User-Email`, so the delete answers 401 and this test **fails** with the remediation printed.

```bash
AXONFLOW_TRUST_IDENTITY_HEADERS=true   # on the AGENT, then restart it
```

Only enable it when every hop that can reach the agent asserts end-user identity from a validated source; see `docs/security/identity-header-trust.md` in axonflow-enterprise.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/revoke-override/test.sh
```
