# Runtime E2E: per-user token (X-User-Token)

Proves the #2945 per-user-token parity through the real OpenClaw host against a live AxonFlow agent (no mocks):

- **L1-L3 (loader legs, the v2.0.4 loader-skip regression class):** the plugin LOADS with `pluginConfig.userToken` present (schema-declared) and emits the value-free canary; loads without it with no canary; a genuinely-unknown key is still REJECTED by the `additionalProperties: false` gate. **L2e** pins the 2.8.1 env-step refactor (single static named read of `process.env.AXONFLOW_USER_TOKEN`, no env-object capture): with no config key and the variable exported, the token resolves via the ENV source, the canary names it, and the value never appears in init output.
- **L4:** a valid minted token + a FORGED `userEmail` → `audit_logs` rows attribute to the token's canonical email; the forged label attributes ZERO rows.
- **L5:** a tampered token (first signature char flipped) → the governed tool call is blocked (fail-closed) and the token value leaks nowhere.
- **L6:** unconfigured → governed traffic flows exactly as pre-2.7.0.

**Prereqs:** `openclaw` + `jq` + `python3` on PATH; a reachable AxonFlow agent (`AXONFLOW_ENDPOINT`, default `http://localhost:8080`) with `AXONFLOW_CLIENT_ID`/`AXONFLOW_CLIENT_SECRET`. Legs L4-L6 additionally need `AXONFLOW_E2E_DB_URL` (+`psql`), a platform that validates `X-User-Token` (enterprise#2929+), a token (`AXONFLOW_E2E_USER_TOKEN`+`AXONFLOW_E2E_USER_TOKEN_EMAIL`, or `AXONFLOW_E2E_JWT_SECRET`+`AXONFLOW_E2E_ORG_ID` to self-sign one on the mint-claims contract), and an LLM key configured in the local openclaw for `OPENCLAW_E2E_MODEL`. Skips cleanly when prereqs are missing.

**Run:** `./runtime-e2e/user-token/test.sh`
