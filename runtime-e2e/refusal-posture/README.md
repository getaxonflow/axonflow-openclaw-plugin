# refusal-posture: runtime E2E

**Asserts**, through the real plugin, the real OpenClaw host and a real agent dispatch against a live AxonFlow community stack, that a refused governance check blocks by default and is never silent (#196):

- **R1. A refused client, `onError: "block"` (the default).** The governed tool call is blocked (the nonce it would read never reaches the agent), the platform's refusal (`ERR_TIER_LIMIT_SERVICE_PRINCIPAL`, or the plugin's "refused the governance check") reaches the session, and the auth breaker's "Authentication failed (HTTP 401)" warning never appears: a refusal is not a rejected credential.
- **R2. A refused client, `onError: "allow"`.** The tool call runs, and the one-shot notice says it ran ungoverned.
- **R3. Vacuity control: the suite's own admitted client, `onError: "block"`.** The tool call runs, with no notice.

## The refusal, and its side effect

A community AxonFlow agent checks no client secret, but admits at most 5 service principals per organization. Past that ceiling a new client id is refused: HTTP 402 `ERR_TIER_LIMIT_SERVICE_PRINCIPAL` on the REST routes the plugin calls (`/api/v1/mcp/check-input`, `/api/v1/mcp/check-output`). The suite first sends one request as its own client (`AXONFLOW_CLIENT_ID`), which keeps that client admitted, then new client ids until check-input refuses one: at most 5 requests.

**On a community stack below its ceiling, those requests admit new client ids, and a later suite that presents a client id the organization has not yet admitted is refused.** Run it on a stack you can reset, or last.

A credential the platform rejects as wrong (HTTP 401) is not producible on a community stack, which checks no secret; that row is proven by the unit tests in `tests/failure-posture-196.test.ts` against the real client.

## Method

Like `failopen-notice`, the suite patches the `axonflow-governance` entry of `~/.openclaw/openclaw.json` for each leg (endpoint, clientId, clientSecret, onError), reinstalls the local plugin, and restores the original config on exit. Each leg's tool call reads a nonce from a file the prompt never contains, so only an executed tool call can report it.

**Prereqs:** the `openclaw` CLI on PATH, on a Node version it accepts (OpenClaw 2026.7.1-2 needs Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0); `jq`; `python3`; `~/.openclaw/openclaw.json`; a live AxonFlow v11.0.0 or later community stack at `$AXONFLOW_ENDPOINT`.

**Run:**
```bash
AXONFLOW_ENDPOINT=http://localhost:8080 \
  bash runtime-e2e/refusal-posture/test.sh
```
