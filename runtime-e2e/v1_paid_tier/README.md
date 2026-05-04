# v1_paid_tier — runtime E2E

**Asserts:** Two features wired into the plugin in one PR — both run end-to-end against a live AxonFlow community-saas stack:

1. **X-License-Token forwarding (W4 paid Pro v1, ADR-049).** Plugin is configured with a license token (env or pluginConfig), the install + first-turn log emits the `[AxonFlow] Pro tier active` canary, and a governed call drives the agent's plugin-claim middleware (`axonflow_agent_plugin_claim_validations_total` counter increments). Sentinel tokens land in `result="invalid_token"` / `"not_found"`; real tokens land in `result="valid"`.
2. **`recover` CLI (W3 free recovery).** Driving `bin/axonflow-openclaw-recover` posts to `/api/v1/recover`, extracts the magic-link token from the agent's capture file, calls `/api/v1/recover/verify`, persists `try-registration.json` at `$AXONFLOW_CONFIG_DIR` with mode 0o600, and the new credentials authenticate against `/api/v1/audit/tool-call`.

**Prereqs:** `openclaw` CLI on PATH (2026.4.27+); `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (default `http://localhost:8080`); the agent must be started with `AXONFLOW_RECOVERY_TEST_CAPTURE_FILE` pointing at a path that's *also* readable by this script (recommended: `-v /tmp:/tmp` on the agent container).

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
AXONFLOW_CLIENT_ID=demo-client \
AXONFLOW_CLIENT_SECRET=demo-secret \
AXONFLOW_RECOVERY_TEST_CAPTURE_FILE=/tmp/axonflow-recovery-captures.txt \
  bash runtime-e2e/v1_paid_tier/test.sh
```

Optional — supply a real plugin-claim token (issued by the platform's Stripe webhook test, see `axonflow-enterprise/runtime-e2e/v1_paid_tier/test.sh`) to flip the assertion from `Δinvalid_token≥1` to `Δvalid≥1`:

```bash
AXONFLOW_LICENSE_TOKEN=AXON-real-token-from-billing \
  bash runtime-e2e/v1_paid_tier/test.sh
```

If the agent is in self-hosted (non-community-saas) mode, Step 2 (`recover`) is skipped automatically — the test exits with a partial pass after Feature 1.
