# audit-search — runtime E2E

**Asserts:** OpenClaw loads the plugin via `openclaw plugins install`, the agent (run with `openclaw agent --local`) picks the registered `axonflow_audit_search` tool from a natural-language prompt, the dispatcher invokes the tool's `execute()` against a live AxonFlow stack, and the response is a non-error `{entries: [...], total: N}` payload returned through the agent's reply.

**Prereqs:** `openclaw` CLI on PATH (2026.4.27+); `jq`; live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` (defaults to `http://localhost:8080`); an LLM provider authenticated for OpenClaw (default `openai-codex/gpt-5.5`, override via `OPENCLAW_E2E_MODEL`).

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
AXONFLOW_CLIENT_ID=demo-client \
AXONFLOW_CLIENT_SECRET=demo-secret \
  bash runtime-e2e/audit-search/test.sh
```
