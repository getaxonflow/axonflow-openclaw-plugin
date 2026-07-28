# status-identity-truth — runtime E2E

**Asserts (#167):** the status surfaces report the endpoint and identity the governance runtime actually uses on a self-hosted install, through the real host and the real bin — not through a direct module import.

Five legs:

| Leg | What it proves |
|---|---|
| S1 | `pluginConfig.endpoint` + `clientId` reach the standalone status CLI. A Community-SaaS registration file carrying a `cs_` tenant is seeded first, so "did not report the cached tenant" is a real assertion and not an absence. Also checks the runtime-state record is written `0600` and carries no credential. |
| S2 | **Vacuity control.** Remove the runtime-state record and re-run the same CLI: it must fall back to `https://try.getaxonflow.com` + the cached `cs_` tenant — the exact v2.8.4 wrong answer. If this leg does not fire, S1 is passing for the wrong reason. |
| S3 | `axonflow_get_tenant_id` reports the same values through a real `openclaw agent` dispatch. |
| S4 | `AXONFLOW_ENDPOINT` in the CLI's own environment still outranks the recorded `pluginConfig` — a persisted value can never win over the reader's live environment. |
| S5 | `openclaw plugins doctor` reports zero diagnostics for `axonflow-governance`. |

**Prereqs:** `openclaw` CLI on PATH with model auth configured; `jq`; `python3`; a live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` for the shared availability gate. The legs themselves talk to a local sentinel listener, not to that stack.

The test backs up and restores `~/.openclaw/openclaw.json`, and pins `AXONFLOW_CONFIG_DIR` to a throwaway directory so the developer's real registration is neither read nor clobbered.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/status-identity-truth/test.sh
```
