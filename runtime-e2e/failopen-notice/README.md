# failopen-notice — runtime E2E

**Asserts (#167):** the `before_tool_call` network fail-open is announced, not silent — through the real host and a real agent dispatch.

E2E testing of 2.8.4 found that pointing the plugin at a dead endpoint let an agent turn execute a shell command containing `DROP TABLE users;` with no governance and no indication of any kind. The fail-open **policy** is deliberate and this test pins that it is unchanged; the silence is what is fixed.

| Leg | What it proves |
|---|---|
| F1 | With the endpoint dead, a real agent turn that invokes a governed tool surfaces the one-shot notice, naming the unreachable endpoint. |
| F2 | **Policy unchanged** — both governed tool calls still executed. A notice paired with a block would be a different, unrequested change. |
| F3 | One-shot: the turn makes two governed tool calls and produces at most one notice. |
| F4 | **Vacuity control** — with the endpoint reachable, the same turn produces NO notice, and the control is proven to have fired by asserting the listener actually received `POST /api/v1/mcp/check-input`. Absence of a notice means nothing if nothing was governed. |

**Prereqs:** `openclaw` CLI on PATH with model auth configured; `jq`; `python3`; a live AxonFlow stack reachable at `$AXONFLOW_ENDPOINT` for the shared availability gate. The legs themselves talk to a dead port and a local listener, not to that stack.

The test backs up and restores `~/.openclaw/openclaw.json`, and pins `AXONFLOW_CONFIG_DIR` to a throwaway directory.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/failopen-notice/test.sh
```
