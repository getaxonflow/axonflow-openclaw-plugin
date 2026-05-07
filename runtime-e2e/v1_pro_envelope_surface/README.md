# Runtime E2E — V1 Plugin Pro envelope surface (OpenClaw)

Verifies that the OpenClaw plugin's compiled `dist/upgrade-prompt.js`
module surfaces the V1 Plugin Pro structured upgrade envelope and honours
the back-off deadline carried in the response.

## What this test exercises

End-to-end against the **real compiled plugin module** (built from
`src/upgrade-prompt.ts` via `npm run build`) running against a **real wire
envelope** captured from the live agent at `https://try.getaxonflow.com`.
No fixtures and no recorded responses — the envelope bytes that flow
into `handleEnvelope` are the bytes the agent emitted to the wire seconds
earlier. Per HARD RULE #0
(`feedback_runtime_proof_is_definition_of_done.md`).

## Why drive the helper directly

The agent emits the V1 Plugin Pro 429 envelope on
`/api/v1/audit/tool-call` (and other apiAuthMiddleware-routed paths).
The plugin's `mcpCheckInput` / `mcpCheckOutput` calls
`/api/v1/mcp/check-input` (and `-output`) which authenticates separately
and currently does NOT route through the daily-cap path that emits the
envelope — so a Free-tier-capped tenant calling those endpoints gets
non-envelope error shapes. The plugin code is correct (the helper
handles both bare and JSON-RPC-wrapped envelopes per the dual-shape
parser in `src/upgrade-prompt.ts`); what's missing is server-side
wiring of the daily-cap into all endpoints that hold a Basic-auth'd
tenant context.

This test still proves what S3 lane is responsible for: the helper
parses the locked V1 envelope shape, surfaces the wording via the
host plugin logger, stamps a future-deadline throttle, and the
once-per-UTC-day stamp suppresses repeated wording on subsequent
fires.

## Steps

1. Register a synthetic Free-tier tenant via DB direct insert
   (`db_helpers.sh` from the sibling `axonflow-enterprise` checkout —
   canonical pattern documented in
   `feedback_ecs_exec_apk_psql_for_db_access.md`). Direct insert avoids
   the per-IP 5/hr rate limit on `/api/v1/register` and gives the test
   a tenant scoped to a known `cs_e2e_openclaw_envelope_<ts>` prefix.
2. Seed `community_saas_daily_usage` to 200 (= the Free cap) for that
   tenant. Loop-to-trip-cap on prod hits a per-IP burst limiter
   (~20/min) long before the daily cap, and that limiter's response
   does NOT carry the V1 envelope.
3. Single `POST /api/v1/audit/tool-call` with the synthetic tenant's
   credentials → `apiAuthMiddleware` fires `writeRateLimitError` and
   the response body is the V1 envelope. Capture it.
4. Assert the wire envelope shape: `limit_type=daily_quota`,
   `tier=Free`, locked wording phrase `Pro raises this to 2,000/day`,
   canonical buy URL, three locked response headers
   (`X-Axonflow-Tier-Limit`, `X-Axonflow-Upgrade-URL`, `Retry-After`).
5. Spawn a Node driver (`driver.cjs`) that requires the compiled
   `dist/upgrade-prompt.js`, reads the captured wire body + headers,
   and invokes `handleEnvelope({ status: 429, body, retryAfterHeader,
   logger })`. Asserts:
   - `result.detected === true`
   - `result.wordingSurfaced === true` (first call)
   - logger received the locked wording + buy URL
   - `isThrottleActive()` returns true after the call
   - `${AXONFLOW_CACHE_DIR}/axonflow/throttle-until` is stamped with a
     future-epoch deadline.
6. Re-run the driver and assert `result.wordingSurfaced === false` —
   the once-per-UTC-day stamp suppresses repeated wording.

The test redirects `AXONFLOW_CACHE_DIR` (which `axonflowCacheDir()`
honours as the highest-priority override per `src/cache-dir.ts`) to a
tmp dir so the throttle file lands hermetically — `HOME` itself is left
intact so the AWS CLI continues to find the operator's credentials for
the ECS-exec preflight + DB seeding.

## Skip conditions

- `curl` / `jq` / `aws` / `openssl` / `python3` / `node` missing → SKIP.
- `python3` `bcrypt` module not installed → SKIP.
- `${AGENT_URL}/health` not reachable → SKIP.
- Stack auto-discovery returned nothing → SKIP.
- `db_helpers.sh` not present at the sibling enterprise checkout → SKIP.

## Usage

```bash
AGENT_URL=https://try.getaxonflow.com bash runtime-e2e/v1_pro_envelope_surface/test.sh
```

Evidence under `runtime-e2e/v1_pro_envelope_surface/EVIDENCE/<utc-ts>/`:

- `envelope_body.json` / `envelope_body_pretty.json` — wire envelope
- `envelope_headers.txt` — full response headers
- `driver.cjs` — Node driver source committed alongside the run
- `driver_out.json` / `driver_out_run2.json` — driver output for both
  invocations (handleEnvelope return + collected logger messages)
- `throttle-until.txt` — copy of the stamped back-off file
- `summary.txt` — top-line PASS / FAIL line

## Cross-references

- Wire contract: `axonflow-enterprise/platform/agent/community_saas_ratelimit_response.go`
- Server-side runtime proof: `axonflow-enterprise/runtime-e2e/v1_pro_envelope_pr1/`
- Plugin module: `src/upgrade-prompt.ts` (compiled to `dist/upgrade-prompt.js`)
- Doctrine: `feedback_runtime_proof_is_definition_of_done.md`
- Umbrella: `axonflow-enterprise#1958`, sub-issue `axonflow-enterprise#1965`
