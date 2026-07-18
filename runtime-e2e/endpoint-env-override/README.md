# Runtime E2E: AXONFLOW_ENDPOINT governance-runtime override (#162)

Proves the documented endpoint precedence (`AXONFLOW_ENDPOINT` > `pluginConfig.endpoint` > default) with live traffic through the real OpenClaw host (no mocks):

- **E1:** `AXONFLOW_ENDPOINT` pointed at a local **sentinel** listener while `pluginConfig.endpoint` points at a different local **decoy** listener → the init canary reports the sentinel with `mode=self-hosted`, the plugin's startup `/health` probe reaches the **sentinel**, the decoy receives **zero** requests, and no Community-SaaS registration runs. Through v2.8.3 this leg fails: the env value was honoured only by the status display while governed traffic used the pluginConfig/default resolution.
- **E2:** env cleared → `pluginConfig.endpoint` still resolves (canary + `/health` traffic on the sentinel).
- **E3:** whitespace-only env is ignored → `pluginConfig.endpoint` wins.

Every `openclaw` invocation pins or clears `AXONFLOW_ENDPOINT` explicitly (`env VAR=` / `env -u VAR`), scoped to the single command — the driver shell commonly exports it for the `_lib` defaults.

**Prereqs:** `openclaw` + `jq` + `python3` on PATH; a reachable AxonFlow agent for the shared availability probe (`AXONFLOW_ENDPOINT`, default `http://localhost:8080`). The override legs themselves target only the local listeners. Skips cleanly when prereqs are missing.

**Run:** `./runtime-e2e/endpoint-env-override/test.sh`
