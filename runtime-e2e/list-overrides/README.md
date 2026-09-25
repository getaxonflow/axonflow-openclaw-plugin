# list-overrides: runtime E2E

**Asserts** that the override read still works on AxonFlow v11.0.0, where the writes are retired:

1. **Pre-flight.** The override write answers HTTP 409 `LEGACY_POLICY_WRITE_FROZEN` (`require_override_write_frozen`), so no override can be seeded; the suite fails on any other answer rather than skipping.
2. **The read.** A real OpenClaw agent turn dispatches `axonflow_list_overrides` (read from the runtime's own tool summary), and the count the agent reports equals the count `GET /api/v1/overrides` returns.

On v11 that count cannot move (no override can be created), so the proof that matters is the dispatch; the count check catches an agent that answered without reading the tool result only when the count is not the guess it would make.

**Prereqs:** the `openclaw` CLI on PATH, on a Node version it accepts (OpenClaw 2026.7.1-2 needs Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0); `jq`; a live AxonFlow v11.0.0 or later stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`).

**Required deployment posture:** the pre-flight write carries a per-user identity, which the AxonFlow **agent** strips unless `AXONFLOW_TRUST_IDENTITY_HEADERS=true` is set on it (default off since 9.9.0); without it the write answers 401 and this test **fails** with the remediation printed. Only enable it when every hop that can reach the agent asserts end-user identity from a validated source; see `docs/security/identity-header-trust.md` in axonflow-enterprise.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/list-overrides/test.sh
```
