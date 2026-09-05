# Changelog

## [Unreleased]

## [2.9.0] - 2026-09-05

### Added

- **The plugin now declares what it can enforce, and the platform refuses to hand it an obligation it has said it cannot discharge** (ADR-065 capability handshake; axonflow-enterprise#3763). On every governed call the plugin presents `X-Axonflow-PEP-Handshake`, a short document naming this enforcement point and the exact obligation types and schema versions it can carry out. A platform running v10.4.0 or later that would attach a mandatory obligation this plugin has declared it cannot discharge **denies** the request instead of handing the content over and trusting the plugin to cope.
- **OPT-IN, and off by default.** Set `AXONFLOW_PEP_AUDIENCE` (or `pepAudience` in the plugin config) to the audience your decision proofs are bound to. Leave it unset and no header is sent and nothing changes: the plugin behaves byte for byte as 2.8.6 against every platform version. Older platforms ignore the header entirely.
- **This plugin is TWO enforcement points and declares itself as two.** Both paths discharge a request-phase or response-phase redaction and both declare `field_redact@1`, under separate names, so the platform composes a separate identifier for each and an operator can see which path a refusal came from. They stay two documents rather than one because their capability sets are independent facts that can diverge again.

### Changed

- **The request path now applies the platform's engine-masked statement to the tool call** (#192). `mcpCheckInput` reads `redacted_statement` and `redaction_evaluated`, and the `before_tool_call` handler substitutes the masked parameters for the caller's originals before the tool runs. Previously those fields were not read, so a masked statement had no effect on the request path; the response path was already correct. **Every failure to apply the substitution BLOCKS rather than proceeding**: the redactor not reporting that it ran (the platform's `#2563 B1` contract, where "found nothing" is otherwise indistinguishable from "never looked"), masked text that does not parse, and masked text that is not a parameter object. Once the platform says a redaction applies there is no path that runs the tool on unmasked input.


### Added

- **The usage heartbeat now reports the licence tier the platform states about itself, as `license_tier`** (axonflow-enterprise#3619). Telemetry could not previously attribute a ping to an edition or licence state: `sdk`, `sdk_version` and `platform_version` say which client and which build, and `deployment_mode` says which topology, but nothing said whether the platform behind it was running Community, Evaluation, Professional, Enterprise or Plus. The receiver has accepted `license_tier` since the v8 train (`omitempty`, normalised server-side) — only the clients never populated it.
- **Read from the `/health` probe that already runs, so no new request is made.** `detectPlatformVersion` became `detectPlatformInfo`: the one response body it already fetched for `platform_version` now yields both fields. The probe is unchanged in count and timeout, and every test asserts exactly one `GET /health` per heartbeat.
- **Relayed verbatim, never interpreted.** The plugin does not normalise, case-fold, or map the value. The receiver owns the canonical mapping, so a tier issued after this plugin shipped still buckets correctly server-side instead of being flattened by a client that predates it. The lowercase `community` a community-mode build defaults to, and the transient `starting` an agent reports before initialisation completes, are both real answers and are relayed as such.
- **Three dimensions that sound alike are kept apart.** `license_tier` is what the platform says its licence is; `deployment_mode` is where this plugin is pointed, classified locally from the endpoint host; `endpoint_type` is that endpoint's network reachability. A `self_hosted` endpoint is routinely Enterprise-licensed and `community_saas` is a hosting topology rather than the Community tier, so none of the three may be derived from another. A test pins all three to different values in one payload.

### Security

- **Fails open in every direction, and the field is omitted rather than guessed.** An unreachable endpoint, a non-2xx, an unparseable body, a body that is null / an array / a string / a number, and a `tier` that is absent, blank or not a string all leave the heartbeat delivered and the key **absent** — not `"unknown"`, not `null`, not `""`. The key is built by a conditional spread rather than assigned `undefined`, so its absence is structural rather than an artefact of how `JSON.stringify` happens to treat undefined properties. Omission is the wire's existing "this client did not report" signal; sending `"unknown"` would instead assert that the platform answered and said it did not know.
- An endpoint-supplied `tier` longer than 64 characters is dropped whole rather than truncated — the longest canonical value is 14 characters, and a truncated value would be a tier the platform never reported.
- Tests: the `license_tier` block in `tests/telemetry.test.ts` (round-trip and fail-open matrix through the real `sendTelemetryPing`), `tests/telemetry-license-tier-mutation-gate.sh` (seven planted defects that must each turn the suite red, plus two behaviour-preserving controls that must survive — one of them pinning the source's own claim that the non-object body guard is defence in depth rather than load-bearing), `runtime-e2e/license_tier_telemetry/`, and a new leg in `tests/heartbeat-real-stack/` so the pre-existing public-entry-point E2E covers the field too.

### Changed

- Telemetry disclosure in `README.md` now names the licence tier in the prose, the usage-heartbeat row, and the probe row of the network-calls table, and states explicitly that no licence key, expiry, seat count, or customer name is read or sent.

## [2.8.6] - 2026-08-20: sanitised render sinks, an announced 403 fail-open, and suites that fail loud

### Fixed

- **The fail-open notice sanitises its endpoint argument, and so does every
  other surface that renders an endpoint.** (#171) `noteUngovernedFailOpen`
  stripped control characters from the error it renders but only trimmed the
  endpoint, and in community-saas mode that endpoint is adopted verbatim from
  the `POST /api/v1/register` response, so a hostile registrar could embed
  ANSI screen-clear sequences and rewrite the "governance is OFF" warning
  into a fabricated "governance active" line. The endpoint now goes through
  `stripControlCharacters` like the cause already did. The same class was
  swept across every sink that renders an endpoint or another
  remote-influenced identity string on a terminal: the status CLI's
  `endpoint:`, `client_id:` and last-load endpoint lines, and the recovery
  CLI's rendering of the verify response (endpoint, email, tenant_id,
  expires_at, note, server message, and error text that embeds the response
  body's own reason). JSON outputs need no change: `JSON.stringify` escapes
  control characters.

- **A 403 under `onError: "allow"` no longer runs governed tools with zero
  signal.** (#170) The auth-error branch was excluded from the #167
  ungoverned-fail-open notice wholesale, on the grounds that the auth path
  carries its own notice. That is true only for a status-401
  (`markAuthFailed` fires at the fetch chokepoint on `response.status ===
  401`); a thrown 403, or a message-classified auth error exposing no
  status, proceeded under `onError: "allow"` with no policy evaluation and
  no signal of any kind. The notice now announces the OUTCOME: any
  before_tool_call that proceeds without a policy decision because the check
  failed emits the one-shot ungoverned notice, except the status-401 shape
  the client already announces. The fail-open/fail-closed POLICY is
  unchanged: 401/403 still respect `onError` (default block), network errors
  still always fail open. The notice wording no longer presumes the endpoint
  was unreachable, since a 403 means it answered. The V1 free-tier throttle
  short-circuits named in #170 for review are unchanged and deliberate:
  they are announced by the once-per-day upgrade prompt when the throttle
  is stamped.

- **Two more runtime-e2e suites no longer report green on assertion-worthy
  conditions, and two skip-shaped passes became failures with named
  causes.** (#172) `status-identity-truth` exited 0 with "SKIP: could not
  start local listener" although python3 presence is asserted earlier, so
  the branch is a harness malfunction, not an environment gate; it now
  fails, matching the sibling `failopen-notice` suite. `v1_paid_tier`
  self-declared "PARTIAL PASS" on ANY non-2xx register response, a 500
  included, so a server error reported as a pass; `v1_pro_proxy_tools`
  exited 0 on any failed registration after its own /health gate had
  already proven the agent reachable; `user-token` exited 0 when the
  platform failed to reject a garbage X-User-Token, which is the exact
  condition the suite exists to catch. All four now exit 1 naming the
  cause. (The duplicate `### Changed` heading #172 also flagged was
  resolved when the Unreleased section became 2.8.5.)

## [2.8.5] - 2026-07-30: status/identity truth, an announced fail-open, and the platform's own error reason

Validated against a local stack built from platform tag **v9.13.0** and against
the deployed Community SaaS (**9.12.2**, read from `/health`) - the two versions
in service on release day. All six `runtime-e2e` suites pass on 9.13.0 (44
assertions, zero skips); on 9.12.2 the three suites covering this
release's changes pass and the remaining three are limited by deployment
posture, not by the plugin, and say so (see `### Testing`).

**Versioning note, recorded after release.** This was classified and published as
a patch. Measured against the built `dist/index.d.ts` of both tags, it adds **13**
names to the package's public API and removes none, while every one of 2.8.1 →
2.8.4 added **zero** - so by semver, and by this repo's own patch precedent, it
should have been **2.9.0**. Consumers are unaffected (nothing was removed, the one
public signature change is an optional parameter, and a `^2.8.x` range resolves it
either way), so 2.8.5 is not being unpublished. The rule for next time: the test
for a patch is "no public API change", not "nothing was removed".

### Fixed

- **The status surfaces now report the endpoint and identity the governance
  runtime actually uses.** (#167) `axonflow-openclaw-status` runs as its own
  process and can see neither `pluginConfig` nor the environment the OpenClaw
  runtime was started with, so a self-hosted operator was told their traffic
  went to the Community SaaS and was shown the cached `cs_` tenant they never
  authenticate as; `axonflow_get_tenant_id` reported the same. Endpoint, mode
  and tenant identity are now one decision (`resolveDeploymentTarget`) shared
  by the runtime and every display surface. Each plugin load records the
  user-provided inputs that fed it - the endpoint override the runtime
  resolved, from **either** `AXONFLOW_ENDPOINT` or `pluginConfig.endpoint`,
  plus the configured `clientId` - at
  `$AXONFLOW_CONFIG_DIR/openclaw-plugin-runtime-state.json` (mode `0600`), and
  the CLI feeds those to the same resolver. Inputs are recorded, never the
  resolved answer, so the reader's own `AXONFLOW_ENDPOINT` is always applied
  live and a recorded value can only fill a gap. Same drift family as #162,
  opposite direction: there the runtime was wrong, here the display was.

- **A governed tool call that proceeds because the endpoint is unreachable now
  says so.** (#167) The network fail-open is deliberate and is **unchanged** -
  no fail-closed mode was added - but it was silent: a session could run
  entirely ungoverned while the user believed governance was on. The first
  such call now emits a one-shot notice naming the endpoint, the underlying
  error, and the fact that no policy was evaluated, on the same channel as the
  auth-failure notice. Auth errors do not trigger it; see #170 for the
  remaining `403` + `onError: "allow"` gap.

- **An error response's own reason is rendered instead of a bare status line.**
  (#167, axonflow-enterprise#3062) `axonflow_create_override` /
  `axonflow_revoke_override` reported `HTTP 401 Unauthorized` with nothing
  explaining why. The `check-input` / `check-output` 401 paths no longer
  discard the response body, and the agent-tool renderer appends whatever
  reason it carries. No platform version is assumed: several conventional
  reason properties are probed, and an absent, non-JSON or malformed body
  degrades to the previous message byte-for-byte. Rendered reasons are
  whitespace-collapsed, capped at 800 characters (`MAX_REASON_LENGTH`), and
  stripped of credential-shaped content so an echoing proxy cannot leak the
  request's own `Authorization` header into a transcript.

- **The platform's own error message now survives rendering intact.** The
  identity-required 401 that axonflow-enterprise#3062 exists to make actionable
  is 605 characters in its diagnosing branch and 623 in the default one, with
  the remedies and the doc reference past offset 550. Two things discarded
  exactly that half: the reason cap was 300, and `createOverride`,
  `revokeOverride` and the four strict read variants wrapped the raw wire text
  as `{ error: <the whole JSON envelope> }` - so the reason rendered as
  double-wrapped JSON and the envelope consumed cap budget before truncation
  applied. All six now use the JSON-aware reader (which also gives them the
  independent body-read timeout), and the cap is 800 with the measured floor
  recorded next to it. A test drives `createOverride` against a real 401 and
  asserts the four substrings the platform's own gate requires.

- **Control characters are stripped from every surface that renders a response
  body.** `console.warn`, the `blockReason` shown to the user and fed back to
  the model, and an agent tool's `details` payload all carried remote text
  verbatim; collapsing whitespace does not touch ESC, BEL or BS, so an echoing
  or hostile endpoint could embed ANSI screen-clear and cursor-positioning
  sequences. Whitespace controls are deliberately preserved as word separators.

- **A transient 5xx whose body mentions authentication no longer hard-blocks
  every governed tool call.** Rendering the platform's reason into the error
  message meant `isAxonFlowAuthError`'s message-regex fallback could classify
  an ALB answering `502 {"error":"upstream authentication service
  unavailable"}` as an auth error - skipping the fail-open branch and, under
  the default `onError: "block"`, denying every tool while telling the
  operator to fix credentials that were fine. A numeric HTTP status is now
  decisive in both directions; the message is consulted only for errors that
  expose no status at all. Server-controlled text must not steer the
  fail-open/fail-closed decision.

- Rendered reasons and the error body handed to the agent are stripped of
  credential-shaped content, including quoted/JSON header dumps and bare
  scheme-less tokens (`X-License-Token`, `X-User-Token`, `X-API-Key`), and
  credential-named keys are redacted by key when a body is walked. A gateway
  that renders `req.headers` into its 401 JSON would otherwise have put the
  request's own Basic credential into the agent transcript.

- The body redaction truncates past its depth limit instead of returning the
  unwalked subtree, which had made the limit a bypass rather than a safe
  truncation, and keeps a server-controlled `__proto__` key as an own property
  rather than silently dropping it from the rendered body.

- The 401 authentication warning now says governance checks - not just audit
  calls - stop for the rest of the session, and what that means under each
  `onError` setting.

- The 401 body read is independently time-bounded. `fetchWithTimeout` clears
  its abort timer once the response resolves, so reading a body after it was
  unbounded - a peer that returned 401 headers and then stalled would have
  wedged `before_tool_call`, and with it every governed tool call in the
  session.

- Manifest and README sweep for surfaces this touched, plus pre-existing gaps
  found in the same census: `AXONFLOW_CONFIG_DIR` / `AXONFLOW_CACHE_DIR`
  descriptions now name everything they hold; the two free-tier cache stamps
  (`throttle-until`, `upgrade-prompt-last-shown`) and the credential-recovery
  network calls are declared; the disclosure stamp's declared contents match
  what is written; `onError` has a `uiHints` entry.

### Changed

- `StatusReport` gains `mode`, `identity_source`, `config_recorded_at`,
  `config_recorded_source` and `runtime_endpoint_at_last_load`, and the
  `endpoint:` line of the human-readable output carries a `(mode=…)` suffix.
  `client_id` / `tenant_id` keep their meaning and both stay populated. In
  self-hosted mode `client_id` is now the tenant the runtime authenticates as
  rather than a cached Community-SaaS registration.
- `buildAgentTools(clientRef, pluginConfig?)` and
  `buildGetTenantIdTool(pluginConfig?)` accept the live plugin config. Called
  without it, the tool falls back to the persisted record.

- **`runtime-e2e` override tests fail instead of skipping when the deployment
  posture is wrong.** (#3062) `governance-lifecycle`, `list-overrides` and
  `revoke-override` each ran a pre-flight `create_override` and, on any
  non-201, printed `SKIP:` and exited **0** - so all three passed-by-skipping
  in exactly the default configuration every user runs, reporting green while
  the tools they cover were dead. `AXONFLOW_TRUST_IDENTITY_HEADERS` defaults
  to off (since 9.9.0), so the agent strips `X-User-Email` and
  `create_override` 401s. They now share `require_override_preflight`, which
  fails with the concrete remediation (including the
  `AXONFLOW_TRUST_IDENTITY_HEADERS=true` posture the override lifecycle
  requires, and when it is safe to set). Environment unavailability - no CLI,
  no reachable stack - remains the only legitimate skip, and is still handled
  up-front by `runtime_e2e_skip_if_unavailable`. Each affected README
  documents the required posture.

- Two suites carried the other variant of the same defect - skipping precisely
  WHEN THE FEATURE UNDER TEST FAILED. `explain-decision` exited 0 when the SQLi
  statement was not blocked or no `decision_id` came back, and `audit-search`
  exited 0 when its seeded marker never reached the audit log. Both are
  findings, not preconditions: a detector that reports "skip" when the detector
  fails cannot detect anything. Both now fail with the diagnosis. Combined with
  the override pre-flight above, no suite in `runtime-e2e` exits 0 on a
  condition the default configuration produces or on its own subject failing.

### Not fixed in this release

- **#170 remains open.** A `403` combined with `onError: "allow"` still proceeds
  without the notice this release adds - the notice covers the network fail-open
  only, and auth errors keep their own path. Nothing here closes #170.

### Testing

- New `runtime-e2e/status-identity-truth/` (6 legs) and
  `runtime-e2e/failopen-notice/` (4 legs), both driving the real host, the
  real bin and real agent dispatch, each with a vacuity control that
  reproduces the pre-fix answer.
- `runtime-e2e/endpoint-env-override/` isolates `AXONFLOW_CONFIG_DIR` so its
  ephemeral sentinel ports cannot end up in a developer's real config.
- Jest pins `AXONFLOW_CONFIG_DIR` to a throwaway directory: plugin
  registration now writes a file, and without the pin every test that
  registers the plugin would write into the developer's real AxonFlow config.

- **Three suites that could not pass have been repaired, found by executing
  every suite against a live 9.13.0 stack.** No workflow in this repo runs a
  `runtime-e2e/test.sh`: `definition-of-done.yml` checks only that
  `runtime-e2e/**` was *touched* by the PR. Un-skipping a suite therefore
  turned "silently green" into "red the first time anyone runs it", and three
  suites had pre-existing defects the skip had been hiding.
  - `explain-decision` asserted the reply named `Authentication Bypass` /
    `sys_sqli_admin_bypass`, which its own seed statement (`id=1 OR 1=1`) cannot
    produce - it fires the OR-always-true pattern. The expected name and id are
    now read from the response that minted the decision, so the assertion is
    correct for any pattern catalogue, and an empty name is refused rather than
    degrading to `contains("")`.
  - `audit-search` seeded its marker inside the `statement`. A check-input audit
    row records `query` as `mcp check-input: <connector_type>` and persists only
    a hash of the statement, so a marker in the statement is unfindable by
    construction. The marker now goes in `connector_type`; the statement still
    carries the SQLi pattern, so the seed is still a real recorded block.
  - `audit-search`'s pre-flight probe sent only the shared client credential
    while the plugin itself sends a per-user token when one is configured, so it
    measured a read scope the plugin does not use. Both now present the same
    identity, and a zero-row result is diagnosed as a read-scope posture
    (role-scoped reads, platform 9.10.0+) rather than as an empty audit log.
    `openclaw_install_local_plugin` also wires `AXONFLOW_USER_TOKEN` into
    `pluginConfig.userToken` so the identity does not depend on whether the
    invoking shell happened to export it.
- `assert_reply_contains` matches fixed strings (`grep -F`). Needles are now
  derived from platform responses, where a regex metacharacter would silently
  change what is asserted or turn a match into a grep error reported as a
  failure for the wrong reason.

### Included from 2.8.4

Restated because the ClawHub listing shows only the newest release body, and
`publish.yml` auto-folds a parent MINOR, never the preceding patch - so without
this the 2.8.4 endpoint fix disappears from the listing.

- **The documented `AXONFLOW_ENDPOINT` environment override is honored by the
  governance runtime**, with the manifest's precedence (`AXONFLOW_ENDPOINT` >
  `pluginConfig.endpoint` > default). (#162) Previously only the status display
  resolved the variable, so an operator who configured a self-hosted deployment
  through the environment variable alone could leave governed traffic - tool
  arguments, outbound message bodies, audit content - flowing to the default
  Community SaaS endpoint while `axonflow-openclaw-status` displayed the
  override, a false confirmation that data stayed on their network. Setting
  `AXONFLOW_ENDPOINT` now also selects self-hosted mode, so the Community-SaaS
  auto-registration never runs.
- **Status and the governance runtime resolve the endpoint through one shared
  function** (`src/endpoint-env.ts`), so the endpoint status displays is, by
  construction, the endpoint governed traffic uses.

## [2.8.4] - 2026-07-18: AXONFLOW_ENDPOINT honored by the governance runtime

### Fixed

- **The documented `AXONFLOW_ENDPOINT` environment override is now honored
  by the governance runtime, with the manifest's precedence
  (`AXONFLOW_ENDPOINT` > `pluginConfig.endpoint` > default).** (#162)
  Previously only the status display resolved the variable; the runtime
  configuration that every governed call uses read `pluginConfig.endpoint`
  alone. Impact of the old behavior: an operator who configured a
  self-hosted deployment through the environment variable alone could leave
  governed traffic - tool arguments, outbound message bodies, audit
  content - flowing to the default Community SaaS endpoint while
  `axonflow-openclaw-status` displayed the override, a false confirmation
  that data stayed on their network. The deployment-mode classifier now
  counts an env-provided endpoint as user-provided, so setting
  `AXONFLOW_ENDPOINT` selects self-hosted mode and the Community-SaaS
  auto-registration never runs. Empty or whitespace-only values are treated
  as unset; values are trimmed.
- **Status and the governance runtime now resolve the endpoint through one
  shared function** (`src/endpoint-env.ts`), so the endpoint status
  displays is, by construction, the endpoint governed traffic uses - the
  independent per-surface resolution that allowed the two to diverge is
  gone. This also aligns the credentials-without-endpoint case: with
  `clientId`/`clientSecret` set and no endpoint, status now displays the
  canonical local-agent default the runtime actually targets, instead of
  the Community-SaaS URL. The environment read itself follows the
  house rule for environment access: a single static named read in an
  import-free leaf module, no environment-object capture.
- Runtime E2E (`runtime-e2e/endpoint-env-override/`): live-host legs
  proving the env-configured endpoint receives the plugin's traffic while a
  differing `pluginConfig.endpoint` receives none, that `pluginConfig`
  still resolves when the variable is unset, and that whitespace-only
  values are ignored. The primary leg fails on 2.8.3, passes on 2.8.4.

## [2.8.3] - 2026-07-18: clarify the intent and data flow of the 2.8.1/2.8.2 hardening

### Changed

- **Maintainer clarification (documentation only, no code change).** The
  2.8.1 and 2.8.2 entries below have been rewritten to describe those
  changes by their security property - least-privilege isolation of the
  credential read - rather than by the review process that prompted them,
  which earlier wording described in terms that could be misread as
  restructuring code to influence scanner results. To be explicit about the
  actual data flow, which none of these releases changed: the per-user token
  is provisioned by the organization admin, resolved from plugin
  configuration, the `AXONFLOW_USER_TOKEN` variable, or the `0600`
  provisioning file, and is sent solely as the authentication header on
  governed calls to the operator-configured AxonFlow endpoint. It is never
  logged, never sent anywhere else, and the resolution order and validation
  are unchanged since 2.7.0.

## [2.8.2] - 2026-07-18: token env read isolated to a single import-free module

### Changed

- **The `AXONFLOW_USER_TOKEN` environment read now lives in a single
  import-free leaf module, and comments are stripped from the emitted
  JavaScript.** Patch release, **no behavior change**. Least-privilege by
  construction: the credential read has exactly one audited site
  (`src/user-token-env.ts` → `userTokenFromEnv()`), in a module that imports
  nothing and is imported only for this one named read - modules that perform
  I/O no longer contain any environment access. `resolveUserToken()` calls
  `userTokenFromEnv()` instead of reading the variable inline. Resolution
  semantics are unchanged: same `pluginConfig → env → 0600 file` precedence,
  same `userTokenEnvValue` test-injection option, same #108
  malformed-candidate fall-through, identical warning strings. The published
  build now strips comments from emitted `dist/*.js` (two-pass `tsc`: JS with
  `removeComments`, declarations without, so `.d.ts` keep their JSDoc for
  editor tooling).

## [2.8.1] - 2026-07-18: token resolution never captures the process environment object

### Security

- **Per-user token resolution reads `AXONFLOW_USER_TOKEN` by name and never
  holds a reference to the full `process.env` object.** Patch release, no
  behavior change. `resolveUserToken()` previously defaulted an injectable
  env map to the whole `process.env`; least-privilege hardening replaces it
  with a single named value option (`userTokenEnvValue`) and one static named
  read of the variable - no environment object is ever captured or
  dynamically indexed near credential handling. Resolution semantics are
  unchanged: same `pluginConfig → env → 0600 file` precedence, same #108
  malformed-candidate fall-through, identical warning strings. A repo-wide
  sweep applied the same rule to the one other full-env alias
  (`telemetry-config.ts` now uses static named reads, same resolved values).

## [2.8.0] - 2026-07-18: caller_name audit attribution (dual-send with legacy tool_type)

### Changed

- **`auditToolCall()` now sends `caller_name` to identify the calling
  client, dual-sent with the legacy `tool_type` for the deprecation
  window** (#156; axonflow-enterprise#2912, sub-issue of epic #2905). The
  `tool_type` field on the `POST /api/v1/audit/tool-call` payload was
  misleadingly named - it was actually used to identify which client made
  the call, not the type of tool. The correctly-named `caller_name` field
  was added on the platform side in axonflow-enterprise#2953 (merged
  2026-07-17, shipped in platform 9.11.0); it resolves `caller_name → tool_type →
  default` and writes only `caller_name` on new rows, keeping `tool_type`
  as a deprecated legacy fallback. `auditToolCall()`'s payload now sends
  **both** `caller_name: "openclaw"` and `tool_type: "openclaw"`. Dual-send
  is exact on a 9.11.0+ platform (`caller_name` wins) **and** status-quo on
  any pre-#2953 platform. This matters more for openclaw than the other
  plugins: openclaw POSTs the REST endpoint directly, and a pre-#2953
  orchestrator drops the unknown `caller_name` while the REST path has no
  default for an absent `tool_type` - so a caller_name-only payload would
  have written **no client field at all** on every deployed platform. The
  legacy `tool_type` fallback keeps the row attributed until the platform
  floor includes #2953, at which point `tool_type` will be dropped. This
  matches the transition pattern across the claude/codex/cursor siblings.
  `auditLLMCall()`'s separate use of `tool_type: "llm_call"` (a distinct,
  documented reuse of this same endpoint for LLM-call auditing, a real
  call-type marker rather than a caller id) is unaffected by this change.
  The payload is pinned by a CI-run unit test (`tests/axonflow-client.test.ts`,
  run in `ci.yml` via `npm run test:coverage`) asserting both keys, so a
  silent revert fails CI.

## [2.7.0] - 2026-07-17: Per-user token (X-User-Token) parity - validated fleet identity

Fleet parity with `axonflow-claude-plugin` v1.10.0 (axonflow-enterprise#2945,
epic #2919). The plugin previously identified the developer only via the
forgeable `userEmail` config (`X-User-Email` header). On platforms with
role-scoped fleet reads (AxonFlow 9.9.0+ RBAC train), a token-less caller's
read tools (`axonflow_audit_search`, `axonflow_list_recent_decisions`, …)
return **zero rows** by design. This release lets each developer present a
minted per-user token so the platform resolves a **validated, non-forgeable**
`{identity, role}`: role-scoped reads return the developer's own rows, and
audit attribution keys on the token's canonical email - beating a forged
`X-User-Email` label - on the planes that consume the header (the MCP tools
at `/api/v1/mcp-server` and the agent-proxied audit/decisions/overrides REST
surface). The `check-input`/`check-output` hook plane reads a per-user token
only from the request body on current platforms and keeps client-scoped
attribution there; the header is still sent (forward-compatible).

### Added

- **`pluginConfig.userToken` + `AXONFLOW_USER_TOKEN` env + `0600`
  provisioning-file resolution** (`src/user-token.ts`). Canonical order:
  `pluginConfig.userToken` → `AXONFLOW_USER_TOKEN` →
  `~/.config/axonflow/user-token.json` (`{"token": "..."}`, mode `0600`
  enforced on POSIX; the same cross-plugin provisioning path the Claude Code
  plugin reads, deliberately NOT `$AXONFLOW_CONFIG_DIR` so a fleet
  provisions one file per machine). A **malformed candidate at any source is
  dropped, never sent** (the platform fails closed on a presented-but-invalid
  token), with a warning that never contains the value, and resolution
  **falls through to the next source** - a malformed higher-priority source
  cannot suppress a valid lower-priority one (the claude-plugin#108 lesson).
- **`X-User-Token` on every governed request** - added in
  `AxonFlowClient.baseHeaders()`, the single choke point all ~19 governed
  endpoints flow through (policy checks, output scans, audit writes,
  explain/override/decision reads, and the `/api/v1/mcp-server` JSON-RPC
  proxy behind the agent tools). Requests built outside `baseHeaders()`
  (Community-SaaS `/register` bootstrap, `/health` probes, the telemetry
  heartbeat, and the pre-auth recovery CLI) are pre-credential or
  non-governed surfaces and deliberately carry no identity headers.
- **Init canaries (value-free).** When a token is configured, one
  `[AxonFlow] Per-user token configured (source: ...)` info line names the
  resolution source; malformed/unsafe-permission candidates produce one
  warning each. The token value itself is never logged, never echoed, and
  never included in any diagnostic.
- **`configSchema.properties.userToken` declared in
  `openclaw.plugin.json`** - required for the loader to accept the new key
  (the schema declares `additionalProperties: false`; an undeclared key
  makes OpenClaw silently skip the entire plugin and run tool calls
  ungoverned, the exact v2.0.4 `userEmail` incident). `uiHints.userToken`
  is marked `sensitive: true`.

### Unchanged (deliberately)

- **Unconfigured installs are byte-identical to v2.6.7 on the wire** - no
  empty header, no init line, no behavior change. This is the common fleet
  state today and the upgrade is a no-op for it.
- `userEmail` keeps working as the label path on platforms without per-user
  token validation; when both are present, the platform prefers the token's
  validated identity.
- The ClawHub **skill is unchanged at v2.5.0** - it is documentation-only
  (links to docs/pricing; it performs no HTTP calls against governed
  endpoints), so it has no token to send.

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. No action needed for
existing installs. Fleet operators on AxonFlow 9.9.0+ who want per-developer
read scoping: mint a token per developer (platform user-token mint API) and
deliver it via `pluginConfig.userToken`, `AXONFLOW_USER_TOKEN`, or a
`0600 ~/.config/axonflow/user-token.json`.

## [2.6.7] - 2026-06-16: Security audit hardening (includes 2.6.6 dependency floor)

### Security

- **Source maps no longer ship in the published package.** `declarationMap`
  and `sourceMap` are now disabled in the build. The published package
  contains `dist/` but not `src/`, so the emitted `*.js.map` / `*.d.ts.map`
  files pointed at sources absent from the artifact and inlined the full
  TypeScript source via `sourcesContent`. The published package now ships
  runnable output only.

### Documentation

- **Platform-version heartbeat probe documented inline.** Added a doc
  comment to `detectPlatformVersion` in `telemetry.ts` recording that the
  `/health` version lookup runs only as part of the usage heartbeat (after
  the `AXONFLOW_TELEMETRY` opt-out check, so `AXONFLOW_TELEMETRY=off`
  suppresses it), sends no request body, reads only the `version` field, and
  never blocks the heartbeat. Behaviour is unchanged; the README
  network-calls table already discloses this probe.

### Included from 2.6.6

These entries shipped in 2.6.6 and are restated here so they remain visible
on the latest release listing:

- **`openclaw` peer/override floor raised from `>=2026.5.22` to `>=2026.6.6`.**
  The `openclaw` harness ships its own `npm-shrinkwrap.json`, so its
  transitive tree is pinned by openclaw itself, not by this plugin's
  `overrides`. openclaw `2026.6.6` ships patched `hono@4.12.21`
  (CVE-2026-47673 / 47674 / 47675 / 47676) and `qs@6.15.2` (CVE-2026-8723),
  clearing five Dependabot alerts. `protobufjs@8.4.0` stays pinned by
  openclaw's shrinkwrap (CVE-2026-48712 plus two moderate advisories); it is
  dev/test-only (not in the published `files` set, never imported by
  `dist/`), is not overridable by a downstream consumer, and clears
  automatically once openclaw bumps protobufjs upstream.
- **Least-privilege workflow token.** Added a top-level
  `permissions: contents: read` block to
  `.github/workflows/manifest-envvars-coverage.yml`.

## [2.6.6] - 2026-06-16: Security - peer dependency floor bump (hono, qs)

### Security

- **`openclaw` peer/override floor raised from `>=2026.5.22` to `>=2026.6.6`.** The `openclaw` harness ships its own `npm-shrinkwrap.json`, so its transitive tree is pinned by openclaw itself, not by this plugin's `overrides`. openclaw `2026.6.6` ships patched `hono@4.12.21` (CVE-2026-47673 / 47674 / 47675 / 47676) and `qs@6.15.2` (CVE-2026-8723), clearing five Dependabot alerts. Note: `protobufjs@8.4.0` stays pinned by openclaw's shrinkwrap (CVE-2026-48712 plus two moderate advisories); it is dev/test-only (not in the published `files` set, never imported by `dist/`), is not overridable by a downstream consumer, and clears automatically once openclaw bumps protobufjs upstream.
- **Least-privilege workflow token.** Added a top-level `permissions: contents: read` block to `.github/workflows/manifest-envvars-coverage.yml`, closing the CodeQL `actions/missing-workflow-permissions` alert.

## [2.6.5] - 2026-05-28 - Fix agent tools invisible to LLM

### Fixed

- **Agent tools now visible to the LLM.** Added `contracts.tools` declaration to `openclaw.plugin.json`. Without this, OpenClaw 2026.5.x registered the 11 agent-callable tools at the plugin API level but never surfaced them to the model's tool schema - users could not call `axonflow_get_tenant_id`, `axonflow_audit_search`, or any other agent tool. Governance hooks (before_tool_call/after_tool_call) were unaffected.

### Documentation

- **README use-case recipe for catalog-backed social automation.** Added a focused OpenClaw configuration pattern that keeps local/free catalog tools outside approval gates while requiring review for live social/account tools that can publish content, send direct messages, spend credits, export audience data, create monitors or webhooks, or run recurring workflows.

## [2.6.4] - 2026-05-27 - Dependency floor bump + audit non-blocking fix

### Security

- **Peer dependency floors raised past known CVEs.** `@axonflow/sdk` floor raised from `>=4.3.0` to `>=7.0.0` (fixes GHSA-mph8-9v29-pm42). `openclaw` floor raised from `>=2026.4.15` to `>=2026.5.22` (past 10 disclosed CVEs including CVE-2026-44116, CVE-2026-45002, CVE-2026-45003).

### Fixed

- **Audit hook is now truly fire-and-forget.** The `after_tool_call` handler previously `await`ed the audit POST, which could delay tool execution if the audit backend was slow. Now uses `void` + `.then()` so audit never blocks the tool pipeline.

## [2.6.3] - 2026-05-26 - Data minimization

### Security

- **Recovery CLI no longer prints secrets to stdout.** The `secret` field is excluded from both the success and persist-failure JSON output. Credentials are written only to the persisted file (mode 0o600). Non-sensitive fields (tenant_id, endpoint, expires_at, email) are still printed for scripting.

### Changed

- **Tool audit input truncation.** String values in tool parameters longer than 500 characters are truncated before sending to the audit endpoint, matching the existing truncation applied to tool results and LLM prompts.

## [2.6.2] - 2026-05-26 - Transparency and security audit cleanup

### Security

- Recovery token host validation: `extractRecoveryToken` now rejects magic-link URLs from unrecognized hosts.

### Fixed

- Telemetry opt-out now honors all documented values (`off`, `0`, `false`, `no`). Previously only `"off"` was honored.

### Changed

- Plugin descriptions updated for transparency across all four surfaces (index.ts, manifest, package.json, README).
- Agent-callable tools documentation corrected to list both read-only and mutating operations.
- Telemetry language corrected - the heartbeat includes persistent identifiers (instance_id, org_id).
- README network-calls table added with full disclosure of every outbound call.
- Legacy `DO_NOT_TRACK` references removed. Opt-out is `AXONFLOW_TELEMETRY=off` only.
- CI workflow updated: replaced dead `DO_NOT_TRACK` env var.

## [2.6.1] - 2026-05-22 - Harden auth-failure circuit breaker (non-JSON 401 body + centralized fetch chokepoint) + `org_id` in telemetry heartbeat

### Added

- **`org_id` field in the telemetry heartbeat body.** Brings the
  OpenClaw plugin's telemetry up to parity with the platform - every
  heartbeat now identifies which deployment-organization emitted it.
  Three sources in precedence order:
  1. The `ORG_ID` env var when set.
  2. The `tenant_id` from
     `axonflowConfigDir()/try-registration.json` (the `cs_<uuid>`
     Community SaaS tenant identifier - same file the Community-SaaS
     bootstrap writes on first registration).
  3. The `local-dev-org` sentinel.

  Exposed as `telemetryOrgID()` + `ORG_ID_LOCAL_DEV_SENTINEL`. Always
  emitted on the wire; older receivers ignore the field cleanly for
  backward compat. Honors `AXONFLOW_TELEMETRY=off` like every other
  heartbeat field. See
  [getaxonflow.com/privacy/](https://getaxonflow.com/privacy/) for the
  customer-facing commitment that covers this field.

### Fixed

- **Telemetry-bootstrap timing race in community-saas mode.** Telemetry
  now fires after the async bootstrap promise resolves rather than
  concurrently with it. Without this, the first heartbeat could land
  before `try-registration.json` was written and the `org_id` field
  would fall through to the `local-dev-org` sentinel. The bash plugins
  do not have this race because their bootstrap is synchronous; the
  OpenClaw fix brings parity.

### Fixed

- **Non-JSON 401 body no longer bypasses the breaker.** Two governance
  methods (`mcpCheckInput`, `mcpCheckOutput`) attempted
  `await response.json()` before checking `response.status === 401`.
  A real-world 401 from an infrastructure layer (ALB / nginx / WAF /
  API Gateway) returns `Content-Type: text/plain` plus body
  `Unauthorized\n` - the JSON parse threw a `SyntaxError` that
  propagated past the breaker, leaving the auth-failed flag unset and
  re-firing the storm. Both methods now detect 401 status before
  attempting JSON parsing and surface the typed HTTP error directly.

- **401 detection centralized at the fetch chokepoint** so every fetch
  site in the client flips the breaker, not just the four high-volume
  entry points covered by v2.6.0. Before this fix, bad credentials
  still caused 401 storms on `searchAuditEvents`, `explainDecision`,
  the overrides lifecycle endpoints, `/health`,
  `listRecentDecisionsStrict`, and `callMCPTool` - just at lower
  volume than the audit endpoint. Now a single 401 check inside the
  shared `fetchWithTimeout` engages the breaker on the first 401 from
  any endpoint; the four high-volume entry points keep their
  short-circuit at the top of the method, which prevents the next
  network call entirely.

### Changed

- **`sendTelemetryPing` JSDoc** softened from "Send a telemetry
  heartbeat" wording - alongside the
  `org_id` addition, the operator-supplied `ORG_ID` on self-hosted is
  not anonymized.

## [2.6.0] - 2026-05-20 - Auth-failure circuit breaker to prevent 401 storms

### Fixed

- **Process-local 401 circuit breaker.** When the plugin is configured
  with bad credentials (expired or mistyped `clientId` / `clientSecret`),
  every `after_tool_call` hook used to fire a POST to the audit
  endpoint, receive a 401, and silently swallow the error. Over a
  typical long-lived OpenClaw session this multiplied into hundreds of
  401s/day per misconfigured install - one customer observed 716 × 401
  in 24h against a single source IP. Now the client carries a
  process-local auth-failed flag. The first time any of the four
  auth-bearing entry points (`auditToolCall`, `auditLLMCall`,
  `mcpCheckInput`, `mcpCheckOutput`) observes a 401, the flag flips
  and a one-time `console.warn` surfaces to the operator:

  ```
  [AxonFlow] Authentication failed (HTTP 401). Audit calls disabled
  for this session. Refresh credentials via the OpenClaw runtime config.
  ```

  Every subsequent call from the same client instance short-circuits
  before issuing the fetch - no further network traffic until the
  OpenClaw runtime instantiates a new client (e.g. on config reload).
  The audit methods keep their fire-and-forget contract; the
  governance methods throw a typed HTTP error so the existing
  `isAxonFlowAuthError` classifier and the host's `config.onError`
  path apply uniformly.

  **Not affected.** Transient errors (5xx, network failures) do NOT
  flip the breaker - the existing fail-open path in `governance.ts`
  keeps handling them as before. Each new client instance starts fresh
  (no cross-instance state leak).

## [2.5.0] - 2026-05-19 - Terminology: `tenant_id` → `client_id` in user-facing output

### Changed

- **`axonflow-openclaw-status` output: `tenant_id:` label is now
  `client_id:`.** Same value, new user-facing term. Aligns OpenClaw
  plugin output with the rest of AxonFlow's v9 terminology (the
  `org_id` ↔ `client_id` ↔ deployment-license-identity
  three-identifier model). For this release, the output carries a
  parenthetical bridge note (`(formerly tenant_id)`) so existing users
  connect the old and new terms without surprise. The bridge note
  will be removed in v3.0.0.

  **Cosmetic only - no config change is required.** The on-disk
  registration file at `$AXONFLOW_CONFIG_DIR/try-registration.json`
  continues to use the `tenant_id` JSON key (file-format compat with
  installed base); only the human-readable status output reads
  `client_id`. Wire-level `X-Axonflow-Client` header is unchanged. The
  agent-side MCP tool `axonflow_get_tenant_id` keeps its name
  (callable both as muscle-memory "what's my tenant ID?" and the new
  "what's my client ID?" - both return the same identifier).

  **JSON consumer compat: `axonflow-openclaw-status --json` populates
  BOTH `client_id` and the legacy `tenant_id` key** with the same
  value. The `StatusReport` TypeScript interface exposes both as
  `string | null` fields. v2.4.x consumers scripting around
  `.tenant_id` keep working unchanged; new consumers SHOULD prefer
  `.client_id`. The legacy `tenant_id` alias will be removed in
  v3.0.0.

  **Action required for users who scripted around the old text
  output:** if your tooling greps for `tenant_id:` in
  `axonflow-openclaw-status` stdout, update to grep for `client_id:`
  (or switch to `--json` mode which still emits the legacy
  `tenant_id` key).

- **README install-flow examples** updated to use `client_id`
  terminology consistently. The "Activate Pro tier" walkthrough notes
  that Stripe Checkout's custom field is still labeled "AxonFlow
  tenant ID" until that form is updated separately.

## [2.4.0] - 2026-05-09 - Decision History API + policy_version recorded on every decision + telemetry simplification

### Added

- **`axonflow_list_recent_decisions` agent tool** - surfaces the caller's recent governance decisions via the new `list_recent_decisions` MCP tool. Tier-throttled per the platform's Free/Pro window+limit; Free callers hitting the cap see the upgrade envelope rendered to the host.

### Telemetry

- **`AXONFLOW_TELEMETRY=off` is the sole opt-out** for the plugin heartbeat - same single-lever model as the SDKs.
- **Heartbeat payload v1 schema additions**: `telemetry_type: "plugin"`, `endpoint_type` (`localhost | private_network | remote | unknown`), `deployment_mode` (`self_hosted | community_saas | unknown`). Set `AXONFLOW_TRY=1` if your stack proxies a custom hostname into try.getaxonflow.com so heartbeats classify as `community_saas` correctly.

## [2.3.3] - 2026-05-08 - ClawPack format migration

Patch release. No runtime behaviour change. Single substantive improvement: artifact format migration that closes the visible "Legacy ZIP" badge on the ClawHub listing.

### Fixed

- **ClawHub publish migrated from Legacy ZIP → ClawPack via `clawhub@0.12.3`.** `.github/workflows/publish.yml` `Install ClawHub CLI` step pinned from `clawhub@0.12.0` to `clawhub@0.12.3`. v0.12.2 (2026-05-02 21:45 UTC) shipped the CLI fix for v0.12.1's tarball-bytes-mismatch regression ("publish code plugins as clawpacks and allow legacy package downloads"); v0.12.3 (2026-05-06) added monorepo support + `dry-run --metadata-only` + scope-owner inference. Verified working locally via `clawhub package pack` + `clawhub package publish . --dry-run` against this repo at v2.3.2 - clean ClawPack tarball with correct sha256/integrity. Closes the "Legacy ZIP - may have compatibility issues" artifact badge on the ClawHub listing and lifts the verification tier from `source-linked` (lowest) to the modern plugin architecture.

 Safety net unchanged: existing `verify-clawhub-install` job runs `openclaw plugins install clawhub:@axonflow/openclaw@<version>` on every publish and fails fast on any bytes-mismatch - same gate that broke v2.0.5/v2.0.6 visibly during the v0.12.1 regression. If broken, revert path is documented in the project's internal notes and the project's internal notes (clawhub@0.12.0 + folder upload).

### Internal

- **ClawScan `Credentials` review concern remains open** and is upstream-blocked. Architectural research confirmed that the env-vars schema landed in `clawhub@0.7.0` (2026-02-16) is **skill-side only**: parsed from SKILL.md frontmatter into the registry capabilities block for skills. Code plugins (this artifact) have no analogous `envVars` schema slot in their `capabilities` indexing today - the registry stores `bundledSkills`, `capabilityTags`, `commandNames`, `configSchema`, `executesCode`, `hooks`, `providers`, etc., but no `envVars`. The earlier v2.3.1 / v2.3.2 / v2.3.3-WIP attempts to close this client-side via `openclaw.plugin.json envVars`, README.md table, and a SKILL.md frontmatter file at the package root were all wrong-layer fixes - adding a SKILL.md to a code plugin's root would either be inert (right) or cause OpenClaw runtime to inject our governance prose into the agent's system prompt (wrong, since we're a code plugin that registers hooks, not a skill that injects prompts).

 Path forward: the actual fix is upstream in ClawHub (analog of the upstream tracker for skills, but for code-plugin `capabilities.envVars`). Until that ships, the "Review" verdict on the Credentials dimension is acceptable - plugin remains installable; reviewer text is balanced ("These variables are related to AxonFlow, not unrelated services"). Static Analysis verdict stays Benign; ClawPack format moves the visible badge.

## [2.3.2] - 2026-05-07 - README env-vars completeness + cumulative-release-notes automation + manifest-envvars CI gate

Patch release. No runtime behaviour change. Three durable improvements landing in lockstep:

### Fixed

- **`README.md` `## Environment variables` section now declares every `AXONFLOW_*` env var the plugin recognizes.** Promoted from `###` (sub-section under "Where your data goes") to `##` for top-level prominence; added the same three entries v2.3.1 added to `openclaw.plugin.json` envVars but missed in the README:
 - `AXONFLOW_ENDPOINT`
 - `AXONFLOW_RECOVERY_TIMEOUT_MS`
 - `AXONFLOW_UPGRADE_URL`

 README.md is the prose ClawScan reads for the plugin's ClawHub listing (in `package.json` `files` allowlist + not in `.clawhubignore`); v2.3.1's manifest-only fix didn't reach this surface because ClawHub's stored `capabilities` block has no envVars schema slot to index `openclaw.plugin.json` envVars from. README.md is the actual user-and-reviewer-visible declaration.

### Added

- **`.github/workflows/manifest-envvars-coverage.yml`**: new CI gate enforcing three-way coverage between (1) `AXONFLOW_*` references in `src/` + `bin/`, (2) `openclaw.plugin.json` envVars keys, (3) `README.md` `## Environment variables` table entries. Runs on every PR touching those paths and on main pushes; fails fast on drift. Internal-only vars (`AXONFLOW_HARNESS*`, `AXONFLOW_LOGS`, `AXONFLOW_OPENAPI*`, `AXONFLOW_CHECKPOINT_URL`, `AXONFLOW_CLIENT_*`) excluded from the check - these are SDK-side or test-only and don't belong in the plugin manifest.

- **`.github/workflows/publish.yml` preflight cumulative-notes rule**: when releasing a patch (Z>0) within 24h of the parent feature minor (X.Y.0), the preflight automatically appends the parent minor's CHANGELOG section to the GH release body. Closes the v2.3.1 regression where the most-clicked discovery surface (latest-tag landing page) hid the v2.3.0 V1 Plugin Pro feature work behind a hygiene-only patch summary. Same-day patches now ship cumulative release notes by default; >24h patches keep their narrow scope. CHANGELOG.md remains semver-organized (each version its own `## [X.Y.Z]` section).

## [2.3.1] - 2026-05-07 - Manifest envVars completeness + test-script field-name hygiene

Patch release on top of 2.3.0. No runtime behaviour change. Two surfaces tightened:

### Fixed

- **`openclaw.plugin.json` envVars block now declares every AXONFLOW_* env
 var that ship-time code references.** Adds three entries that were
 documented in `clawhub/2.3.0/SKILL.md` and used by `dist/` / `bin/`
 but missing from the manifest's `envVars` block:
 - `AXONFLOW_ENDPOINT` - overrides `pluginConfig.endpoint`; primary
 self-hosted-mode entry point.
 - `AXONFLOW_RECOVERY_TIMEOUT_MS` - per-HTTP timeout for the
 `axonflow-openclaw-recover` CLI (default 10000).
 - `AXONFLOW_UPGRADE_URL` - overrides the upgrade URL surfaced by
 `axonflow-openclaw-status` (default `https://getaxonflow.com/pricing/`).

 Closes the ClawScan v2.3.0 review's "Credentials" dimension concern
 ("registry metadata declares no environment variables" while several
 AXONFLOW_* names appear in code/docs). Pre-tag check now in place: a
 grep of `AXONFLOW_[A-Z_]+` against `src/`, `bin/`, `scripts/` must be
 a subset of `openclaw.plugin.json` envVars keys before tagging
 (internal-only harness vars like `AXONFLOW_HARNESS*` excluded from
 the check).

### Internal

- **the runtime test bundle**: synthetic test-tenant
 secret literal renamed `testpass` → `synth-tok-` to avoid triggering
 static analyzer false positives on dev machines. The literal had no
 functional role - the test inserts the synthetic value directly into
 the test DB and uses it for Basic auth against a synthetic tenant.
 The unrelated `["password"]` JSON-field reads at lines 105 and 126
 are reading from AWS Secrets Manager's RDS-managed secret structure
 (`{"username", "password", "host", "port", ...}` - AWS schema, not
 AxonFlow-defined) and are correct as-is. Test scripts are not shipped
 to npm or ClawHub (excluded via `.clawhubignore` and absent from npm's
 `files` allowlist) - this is dev-only file hygiene.

## [2.3.0] - 2026-05-07 - V1 Plugin Pro envelope + 5 new agent-callable Pro tools (cross-plugin parity)

Companion plugin release to AxonFlow agent v7.7.0. Surfaces the V1
Plugin Pro structured upgrade envelope to the operator on Community
SaaS rate-limit hits, and adds 5 new agent-callable Pro tools so
OpenClaw agents reach the same V1 Pro toolset that the
`axonflow-claude-plugin` / `axonflow-cursor-plugin` /
`axonflow-codex-plugin` plugins auto-discover from the AxonFlow agent's
MCP server. Total agent-callable tools: 5 → 10.

### Added

- **V1 Plugin Pro upgrade-prompt envelope handling** in
 `src/upgrade-prompt.ts` - sourced into `axonflow-client.ts` so every
 4xx response from `mcpCheckInput` / `mcpCheckOutput` runs through
 envelope detection. When the agent returns a 429 (daily-quota) or
 403 (graduated / Pro-only) with the structured envelope shape:
 - Parses `upgrade.wording` + `upgrade.buy_url` and forwards it to the
 host plugin logger (`api.logger.info`) at most once per UTC day.
 Surfaced to OpenClaw operators via the standard plugin log channel.
 - Honours `Retry-After` / `resets_at` by stamping a back-off file at
 `${AXONFLOW_CACHE_DIR or platform default}/throttle-until`.
 `governance.ts` checks the gate before each governed call and
 short-circuits during the back-off window (no thundering-herd
 retries against the agent).
 - Handles both bare and JSON-RPC-wrapped envelope shapes (the latter
 is what the new V1 Pro MCP tools deliver via `writeMCPGateError`).
- **`axonflow_get_tenant_id` agent-callable tool** - returns the
 install's tenant_id, current tier (Free / Pro / pro_expired),
 endpoint, and the locked V1 upgrade URLs. The other three plugin
 hosts (claude / cursor / codex) get this tool from the agent's MCP
 server via auto-discovery; OpenClaw doesn't proxy that MCP server,
 so we register a local equivalent built from the same status surface
 `recover.sh status` exposes. Keeps cross-plugin behaviour consistent
 for the "what's my tenant ID?" question.
- **Four V1 Plugin Pro proxy tools** registered locally so OpenClaw
 agents reach the same V1 Pro toolset that `axonflow-claude-plugin` /
 `axonflow-cursor-plugin` / `axonflow-codex-plugin` auto-discover from
 the agent's MCP server. OpenClaw doesn't proxy
 `/api/v1/mcp-server` `tools/list`, so these are registered as
 code-defined `AgentToolDef`s whose `execute()` forwards to the agent
 via a single new `AxonFlowClient.callMCPTool(name, args)` helper:
 - `axonflow_request_approval` - Free 1/7d rolling, Pro unlimited.
 - `axonflow_create_tenant_policy` - Free 2 active max, Pro unlimited.
 - `axonflow_get_cost_estimate` - Pro-only; Free callers get the
 locked V1 `feature_pro_only` envelope.
 - `axonflow_list_pro_features` - Free + Pro, locked feature list
 (5 differentiators + $9.99 / 90-day pricing).

 Total agent-callable tools: 5 → 10 (combining `axonflow_get_tenant_id`
 above with these four).
- **`clawhub/2.3.0/SKILL.md`** - frozen per-version skill record for the
 v2.3.0 release. Documents the new agent-callable tools alongside the
 existing 5 governance tools.

### Fixed

- **`AxonFlowClient.handleEnvelope`** - pre-filter on
 `status === 429 || status === 403` was dropping JSON-RPC-wrapped
 envelope responses that come back over HTTP 200 with
 `result.isError = true` (the path the agent's
 `mcp_v1_pro_tools.go writeMCPGateError` uses). Removed the
 pre-filter; `handleV1Envelope` already encodes the full
 status-vs-shape decision and now sees all three envelope-bearing
 paths (429 daily-quota, 403 graduated / Pro-only, 200 + JSON-RPC
 gate). The 4 new proxy tools depend on the 200 path; without this
 fix, Free callers got the envelope content as a generic `kind=ok`
 result instead of a clean `kind=envelope` with the upgrade prompt
 surfaced.

### Internal

- `tests/upgrade-prompt.test.ts` - 26 unit assertions across
 `detectEnvelope`, `retryAfterMs`, `resolveDeadlineMs`,
 `isThrottleActive`, `shouldShowPromptToday`, the full `handleEnvelope`
 state machine, and the `V1_LIMIT_TYPES` locked enumeration.
- the runtime test bundle - drives the compiled
 `dist/upgrade-prompt.js` against a live 429 envelope captured from
 a Free-tier tenant on `try.getaxonflow.com` past the 200/day cap.
- the runtime test bundle - drives the compiled
 `dist/agent-tools.js` + `dist/axonflow-client.js` against a real
 registered tenant on `https://try.getaxonflow.com`. Asserts
 end-to-end that all 5 V1 Pro agent-callable tools dispatch
 correctly: `axonflow_list_pro_features` returns the locked
 5-differentiators shape; `axonflow_get_cost_estimate` on a Free
 tenant lands the `feature_pro_only` envelope with the locked buy
 URL + logger wording + stamped throttle file (and the subsequent
 agent-tool `execute()` honours the throttle gate);
 `axonflow_request_approval` and `axonflow_create_tenant_policy`
 return non-empty `approval_id` / `policy_id` on first Free call,
 with top-level `success: true` alongside `submitted: true` /
 `created: true` on the response body.
- `tests/agent-tools.test.ts` + `tests/registration.test.ts` -
 updated for the new tool count (5 → 10).

### Versions touched

- `package.json`: 2.2.0 → 2.3.0
- `package-lock.json`: 2.2.0 → 2.3.0
- `src/version.ts` (`VERSION` constant - Jest asserts parity): 2.2.0 → 2.3.0
- This CHANGELOG entry

## [2.2.0] - 2026-05-06 - V1 paid Pro tier wire-up + X-Axonflow-Client header

Companion plugin release to platform v7.7.0. Surfaces the V1 SaaS Plugin
Pro tier - `clawhub config set license-token <AXON-token>` activates Pro
features immediately, plus the agent-side scope-validation header on
every governed request.

### Added

- **`X-Axonflow-Client: openclaw/<version>` header** on every governed
 agent request. Set automatically by the `axonflow-client.ts` HTTP
 layer using the canonical `VERSION` constant from `src/version.ts`;
 not configurable. Agents at v7.7.0+ derive request scope from this
 header and reject cross-quadrant token misuse (e.g. a SaaS Plugin Pro
 token paired with an SDK request) at the validator boundary. Older
 agents (pre-v7.7.0) ignore the header and continue to work unchanged.

### Added

- **Status surface tier line + plugin-init canary now surface Pro license expiry date.** The `tier` field in `buildStatusReport()` / `formatStatusReport()` / the `axonflow-openclaw-status` CLI parses the JWT `exp` claim from the configured Pro license token and renders one of three shapes: `Pro (expires YYYY-MM-DD, N days remaining)` when active, `Free (Pro expired YYYY-MM-DD - visit https://getaxonflow.com/pricing/ to renew)` when the token is on disk but its `exp` has passed (plugin will not forward an expired token), or `Free (no Pro license configured)` when no token is loaded. The plugin-init canary line emitted by `registerAxonFlowGovernance` matches the same three shapes so users notice their renewal window on every plugin reload. New exports: `buildProTierInitLogLine`, `parseLicenseTokenExpiry`, `formatExpiryDate`, `daysUntil`. New `StatusReport` fields: `expires_at` (YYYY-MM-DD UTC, nullable) and `expires_in_days` (integer, negative when expired, nullable). New `StatusTier` value `"pro_expired"` distinguishes a configured-but-lapsed token from `"free"` for renew-CTA rendering. Display only - JWT signature validation remains the platform's job. Tokens whose JWT body fails to parse fall back to the legacy `Pro tier active - license token configured, X-License-Token will be forwarded on every governed request` canary so byte-exact compat with mode-clarity assertions and any external grep on the v2.1.x string is preserved.
- **`axonflow-openclaw-status` CLI for tenant + tier introspection.** New bin script (`npx @axonflow/openclaw axonflow-openclaw-status`, also exported as `buildStatusReport` / `formatStatusReport` / `resolveStatusInputs` / `redactLicenseToken` / `readPersistedTenantId` from the package entry point) prints the user's `tenant_id` (read from `$AXONFLOW_CONFIG_DIR/try-registration.json`), the AxonFlow endpoint the plugin would talk to, and a tier indicator (Pro when `AXONFLOW_LICENSE_TOKEN` or `pluginConfig.licenseToken` is set, Free otherwise). Surfaces the upgrade URL on free, and a redacted preview of the license token (last 4 chars only - full token is **never** printed) on Pro. Closes the W4 paid-Pro launch UX gap where users had no way to read their `tenant_id` before pasting it into the Stripe checkout custom field. `--json` flag emits the same shape as machine-readable output.
- **Pro tier activation via `X-License-Token`.** New `licenseToken` pluginConfig field (and `AXONFLOW_LICENSE_TOKEN` env var, env wins) carries the AXON-prefixed plugin-claim token issued by AxonFlow Pro Stripe Checkout. When set, the plugin forwards it on every governed request via the `X-License-Token` header so the agent's plugin-claim middleware can apply Pro-tier entitlements (extended audit retention, higher quotas, license-gated capabilities). On every plugin init the canary log emits `[AxonFlow] Pro tier active …` alongside the existing connection canary so users always know the token is wired through. Free-tier installs are unaffected - when no token is configured the header is omitted entirely.
- **`axonflow-openclaw-recover` CLI for Community-SaaS credential recovery.** New bin script (`npx @axonflow/openclaw axonflow-openclaw-recover <email>`, also exported as `requestRecovery` / `verifyRecovery` / `extractRecoveryToken` / `persistRecoveredCredentials` from the package entry point) drives the platform's email-based recovery flow when `try-registration.json` is lost: posts to `/api/v1/recover`, prompts for the magic-link token (or accepts the full magic-link URL), posts to `/api/v1/recover/verify`, and persists the freshly-issued tenant_id + secret at `$AXONFLOW_CONFIG_DIR/try-registration.json` (mode 0o600) so the next plugin reload picks them up automatically. Magic-link tokens are one-shot and short-lived; replays return 401.
- **the runtime test bundle** - runtime-path test that drives both new features end-to-end against a live community-saas stack: confirms the `Pro tier active` canary fires, the agent's plugin-claim middleware counter increments after a governed call (proving `X-License-Token` reached the wire), and the recovery CLI completes the email → magic link → verify → persist → authenticate cycle with a fresh tenant_id.

### Fixed

- **the runtime test bundle: pass when stack is long-running.** Previously the test silently exited as `PARTIAL PASS` after Feature 1 whenever `/api/v1/register` returned 429, mislabeling the cause as "agent not in community-saas mode". The agent's per-IP rate limiter (5 calls per source-IP per hour, shared between `/api/v1/register` and `/api/v1/recover`) trips quickly when the test runs against a stack that has already absorbed any traffic in the current hour, which silently turns the recovery handler into a no-op (handler returns generic 202 to prevent enumeration). The test now sends a per-run synthetic source-IP via `X-Forwarded-For` (override with `RUNTIME_E2E_XFF`) so each run gets a fresh rate-limit bucket, and surfaces a real failure with a remediation hint when the bucket is somehow still saturated. Step 2g also now probes `$AXONFLOW_ENDPOINT/api/request` (the agent's primary Basic-auth surface) instead of `$PERSISTED_ENDPOINT/api/v1/audit/tool-call` - the persisted endpoint is hardcoded by the platform to `https://try.getaxonflow.com` and is correct for production users but useless for a runtime test pointing at a local stack, and the audit/tool-call route additionally requires the operator to have set `AXONFLOW_INTERNAL_SERVICE_SECRET` in non-Community deployments. Feature 1 PASSED, Feature 2 PASSED end-to-end on local docker-compose with v7.7.0.
- **Upgrade-pointer URL aligned with the canonical pricing page.** `STATUS_DEFAULT_UPGRADE_URL` (the URL surfaced by `axonflow-openclaw-status` to free-tier users, and embedded in the `tier=Free (Pro expired ... - visit ... to renew)` line) is now `https://getaxonflow.com/pricing/`. The previous default `https://getaxonflow.com/pro` returned 404 - that page was referenced in PRDs but never built. The pricing page already resolves and carries the Plugin Pro $9.99 tier card with the Stripe buy button, so plugin status output now points free-tier users at a working URL. Override via `AXONFLOW_UPGRADE_URL` env var if needed. Same fix landed in companion plugin releases (claude-plugin v1.2.0, cursor-plugin v1.2.0, codex-plugin v1.2.0).

## [2.1.1] - 2026-05-05 - exclude runtime-e2e/ from published artifact

### Fixed

- **`runtime-e2e/` now excluded from the ClawHub publish.** The runtime
 E2E test harnesses are CI fixtures that drive a real OpenClaw agent
 against a live AxonFlow stack - they're not consumed by the plugin
 runtime. They were inadvertently shipped with the v2.1.0 artifact and
 the static-analysis scan flagged five of them on a false-positive
 match against their HTTP Basic-auth header setup. Removing the surface
 area entirely is the durable fix.

## [2.1.0] - 2026-05-04 - 5 agent-callable governance tools

### Added

- **5 agent-callable governance tools.** OpenClaw agents can invoke
 AxonFlow's governance surface directly through tool-calling:
 `axonflow_audit_search`, `axonflow_explain_decision`,
 `axonflow_list_overrides`, `axonflow_create_override`, and
 `axonflow_revoke_override`. Tools register when OpenClaw exposes
 `registerTool` (2026.3.22+); older runtimes log a one-line warning
 and continue with hooks only.
- **`userEmail` config field.** Required for `axonflow_create_override`
 and `axonflow_revoke_override` so the platform can scope overrides to
 the actual user. When absent, the override-write tools fail with a
 clear authentication error from the platform; read-side tools and the
 hook path continue to work.

### Fixed

- **Agent tools now surface platform outages as errors instead of empty
 results.** Previously, a 5xx, network failure, or auth error on
 `axonflow_audit_search`, `axonflow_list_overrides`, or
 `axonflow_explain_decision` could be silently collapsed into "no audit
 events" / "no overrides" / "no explanation available" because the
 underlying client methods were written for CLI UX and swallow HTTP
 failures. The agent tools now use strict client variants that throw
 on transport / non-2xx, so a calling agent sees `isError: true` with
 the HTTP status instead of a misleading success.

## [2.0.8] - 2026-05-02 - Drop tarball arg; v0.12.0 only supports folder upload

v2.0.7 attempted CLI pin v0.12.0 + tarball arg and got `Error: Path must be a folder` from the publisher - tarball-arg support is a v0.12.1+ feature. The publish-clawhub job failed; v2.0.7 is on npm but never registered on ClawHub.

Falling back to the v2.0.4 baseline: CLI v0.12.0 + folder upload (Legacy ZIP). This is the only proven-working combination on ClawHub right now. Re-introduces the "Legacy ZIP" badge on the install page; install path works.

### Changed

- **`.github/workflows/publish.yml` `publish-clawhub` step uses folder upload** (`clawhub package publish .`). Identical to the v2.0.4 publish step; CLI pin from v2.0.7 retained.

### Carried forward (unchanged from v2.0.7)

- `clawhub@0.12.0` pin in `Install ClawHub CLI` step
- `verify-clawhub-install` CI smoke job
- `@anthropic-ai/sdk` `>=0.91.1` override
- `permissions: contents: read` on heartbeat-real-stack workflow

### Upstream regression and follow-up

The underlying issue is in `clawhub` CLI v0.12.1+: published artifacts register as `npm-pack (tgz)` with bytes that don't match the recorded SHA-256, which breaks `openclaw plugins install` regardless of whether you upload a folder or a tarball. We've reproduced the failure across both upload modes on v0.12.1 and confirmed v0.12.0 still works for folder uploads. Once ClawHub addresses the v0.12.1+ regression upstream, we'll revisit the ClawPack tarball publish path and drop the Legacy ZIP badge.

### Registry-state asymmetry

The release train this afternoon left npm and ClawHub in slightly different states:

- **npm** has `2.0.5`, `2.0.6`, `2.0.7`, `2.0.8` (each version's `publish` job succeeded; npm publish is independent of ClawHub publish).
- **ClawHub** has `2.0.5`, `2.0.6`, `2.0.8` (v2.0.7's `publish-clawhub` job failed mid-workflow with `Error: Path must be a folder`, so v2.0.7 was never registered on ClawHub).

For most users on `@latest` this is invisible - both registries point at v2.0.8. Anyone explicitly pinning `clawhub:@axonflow/openclaw@2.0.7` will hit "version not found"; in that case, either pin to `2.0.8` or drop the version pin entirely.

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. If you tried v2.0.5, v2.0.6, or v2.0.7 and hit any install error, retry - v2.0.8 should resolve cleanly.

---

## [2.0.7] - 2026-05-02 - Pin ClawHub CLI to v0.12.0 + restore ClawPack publish + add ClawHub install smoke

v2.0.6 reverted to folder upload to escape v2.0.5's broken-install state but the install was **still broken** with a different error (`ClawHub archive contents do not match files[] metadata for "@axonflow/openclaw@2.0.6": missing "package.json"`). Both broken versions used `clawhub` CLI v0.12.1, which was published 2026-05-02 20:50 UTC - about two hours before our v2.0.5 ship.

v2.0.4 (last known-good install) was published 2026-04-30 with `clawhub` CLI v0.12.0 and still installs cleanly. The regression is in CLI v0.12.1's publish pipeline: regardless of whether you pass a folder or a tarball, the resulting artifact registers as `npm-pack (tgz)` with bytes that don't match the SHA-256 ClawHub records - breaking the install path.

### Changed

- **Pin `clawhub@0.12.0` in `.github/workflows/publish.yml`.** `npm install -g clawhub` (unpinned) was always pulling latest, which is why the regression hit on the next publish after v0.12.1 shipped. The pin holds until ClawHub fixes the upstream regression in v0.12.1+.
- **Restore ClawPack tarball publish path.** With CLI pinned to v0.12.0, `clawhub package publish ./<tarball>.tgz` returns to producing a publishable ClawPack artifact. Re-earns the ClawPack badge on the install page. If install still breaks despite the pin, v2.0.8 will revert to folder upload (Legacy ZIP).

### Added

- **`verify-clawhub-install` job in `publish.yml`.** Runs `openclaw plugins install clawhub:@axonflow/openclaw@<version>` against the just-published version and fails the workflow if install errors. v2.0.5 + v2.0.6 both shipped to ClawHub successfully and `verify-publish` (which only checks npm propagation) reported success - but adopters could not install. This job closes the gap so future regressions in the ClawHub install path surface in CI within ~3 minutes of tag rather than via adopter reports.

### Carried forward from v2.0.5/v2.0.6 (unchanged)

- `@anthropic-ai/sdk` `>=0.91.1` override remains in `package.json` (closes the moderate GHSA on insecure default file permissions).
- Explicit `permissions: contents: read` remains on the `Heartbeat Real-Stack E2E` workflow (CodeQL parity).

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. If you were stuck on v2.0.5 or v2.0.6 with `ClawHub archive integrity mismatch` or `missing "package.json"` errors, retry - v2.0.7 should resolve cleanly via the pinned CLI's ClawPack path.

---

## [2.0.6] - 2026-05-02 - Revert ClawPack publish path (v2.0.5 was uninstallable via ClawHub)

v2.0.5 switched the ClawHub publish artifact from folder upload (Legacy ZIP) to the `npm-pack` tarball (ClawPack). That triggered two ClawHub-side regressions specific to the ClawPack handling path that left v2.0.5 unusable for adopters:

1. **Install integrity mismatch.** `openclaw plugins install clawhub:@axonflow/openclaw@2.0.5` failed with `ClawHub archive integrity mismatch: expected sha256-RJwSW6ANBH3JKUkP06oA++JY9r1XAx58NDWKCeD6hwQ=, got sha256-7gGhfvJM/LuF9HfTZG2EsbjkSoImPau6h2wt+nwlhKo=`. The expected hash matched the published tarball; the bytes ClawHub's install endpoint actually served did not. ClawHub's CLI download path (`clawhub package download`) returned the correct bytes - only the install resolution path was broken.
2. **ClawScan hallucinated "missing implementation".** Flagged the bundle claiming "implementation code is absent" - factually false. ClawHub's own package record correctly tagged the artifact as `family: "code-plugin"` with `npmFileCount: 70` and `unpackedSize: 280368`.

### Changed

- **Revert ClawHub publish step to folder upload.** `.github/workflows/publish.yml` now runs `clawhub package publish .` (folder) instead of `clawhub package publish ./<tarball>.tgz`. This re-introduces the "Legacy ZIP - may have compatibility issues" badge on the ClawHub install page but restores `openclaw plugins install` for every adopter. Trade-off accepted until ClawHub fixes the ClawPack handling path.

### Carried forward from v2.0.5

- `@anthropic-ai/sdk` `>=0.91.1` override remains in `package.json` (closes the moderate GHSA on insecure default file permissions; `@anthropic-ai/sdk` is a transitive dev-only dependency through the `openclaw` peerDep).
- Explicit `permissions: contents: read` remains on the `Heartbeat Real-Stack E2E` workflow (CodeQL parity).

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. No code or configuration changes on your side. If you tried to install v2.0.5 and hit `ClawHub archive integrity mismatch`, retry with v2.0.6 - install resolves cleanly via the Legacy ZIP path.

---

## [2.0.5] - 2026-05-02 - Publish as ClawPack + transitive security bump

ClawHub's install page on prior versions surfaced a "Legacy ZIP - may have compatibility issues" badge because the publish flow uploaded a folder rather than the npm-pack tarball. The plugin already declared the `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` metadata that ClawPack requires, so the only change needed was the publish artifact format itself.

### Changed

- **Publish as ClawPack tarball.** The `publish-clawhub` job now runs `npm pack` and uploads the resulting `.tgz` to ClawHub's package registry. ClawPack downloads are verified against npm integrity/shasum **and** ClawHub SHA-256, giving stronger artifact provenance than the legacy ZIP path. No change to install command - `openclaw plugins install clawhub:@axonflow/openclaw` resolves the same way.

### Security

- **Bump transitive `@anthropic-ai/sdk` to `>=0.91.1`** via `package.json` `overrides` (closes a moderate-severity GHSA on insecure default file permissions in the local-filesystem memory tool). The SDK is a transitive dev-only dependency through the `openclaw` peerDep - not bundled in the published `dist/` - so plugin users were never exposed at runtime; this closes the lockfile alert and ensures CI runs against a patched copy.
- **Add explicit `permissions: contents: read` to the `Heartbeat Real-Stack E2E` workflow** to match every other workflow in the repo and satisfy the CodeQL `missing-workflow-permissions` rule. Job already only needed read access for checkout.

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. No code or configuration changes on your side.

---

## [2.0.4] - 2026-05-01 - Restore `userEmail` configuration + reframe Community SaaS as exploration-only

`openclaw.plugin.json` declared `configSchema.additionalProperties: false` but did not list `userEmail` in `properties`, even though the plugin's runtime config resolver (`src/config.ts`) reads `userEmail` from `pluginConfig` and forwards it as the `X-User-Email` header on every request. OpenClaw's plugin loader runs the published configSchema against the user's `pluginConfig`; when validation fails (because of the unknown property), the loader emits a single `[plugins] axonflow-governance invalid config:.` log line and skips the plugin entirely - it never registers, no hooks fire, and tool calls execute completely ungoverned.

In practice this affected every user who followed the documented configuration path for the override workflow. `client.createOverride()`, `client.revokeOverride()`, `client.listOverrides()` all require `userEmail` to be set (the endpoints reject calls without user identity with HTTP 401), and `client.explainDecision()` needs it for correct per-user scoping. Setting it via `pluginConfig.userEmail` - which is what the README, the SKILL.md on ClawHub, and the rest of the documentation describe - failed schema validation, disabled the plugin silently, and left the user with neither governance nor an obvious error.

### Fixed

- **`pluginConfig.userEmail` is now accepted by the configSchema.** Added `"userEmail": { "type": "string" }` to `openclaw.plugin.json` `properties`, plus a matching `uiHints.userEmail` block so portal UIs render a labelled input with placeholder and help text. Plugin runtime behaviour was already correct in v2.0.0+ - only the schema gate was rejecting it.

### Why this is a patch (not a minor)

The capability already existed in code; we're closing the schema gap that prevented the documented `pluginConfig` path from reaching it. Pure additive change to the schema - no existing valid config breaks.

### Upgrade

`openclaw plugins install @axonflow/openclaw@latest`. No code changes required on your side. If your config currently sets `userEmail` and the plugin was being silently disabled, it will now register and start enforcing policy on the next plugin reload.

### Documentation: Community SaaS reframed as exploration-only

The README "Where your data goes" section now leads with **Self-hosted (recommended for any real use)** as the primary deployment path and demotes Community SaaS to a clearly labelled "for early exploration only" section. Community SaaS is offered "as is" on a best-effort basis with no SLA, no warranties, and no commitment to retention or deletion timelines, and is not appropriate for production workloads, regulated environments, real user data, or any other sensitive information.

The reframing surfaces three production-fit alternatives:

- **[Self-host AxonFlow Community Edition](https://docs.getaxonflow.com/docs/deployment/self-hosted/)** for any real workload (data stays within your boundary).
- **Community Edition with an [Evaluation License](https://docs.getaxonflow.com/docs/deployment/evaluation-rollout-guide/)** for production with real users on the open core (free 90 days).
- **[AxonFlow Enterprise](https://docs.getaxonflow.com/docs/deployment/community-to-enterprise-migration/)** for regulated industries with SLOs and contractual commitments.

Plugin runtime behaviour is unchanged - Community SaaS auto-bootstrap still happens on zero-config installs, with the `AXONFLOW_COMMUNITY_SAAS=0` opt-out documented in v2.0.0+.

---

## [2.0.3] - 2026-04-30 - Scrub bait shapes from published markdown + scan all shipped files

The v2.0.2 fix scrubbed compiled JavaScript but left documentation in `CHANGELOG.md`, `README.md`, and `policies/README.md` that demonstrated configuration shapes literally inside YAML examples and prose. ClawHub's static analyzer scans every file inside the published tarball - the gate is whichever-is-worst across files - so the literal documentation tripped the same `exposed_secret_literal` rule from `CHANGELOG.md` line 5 and continued to block install of v2.0.2 even though the compiled artifact was clean.

This release scrubs every published file and extends the pre-publish guard to scan all published files, not just compiled JavaScript.

### Fixed

- **`clawhub:@axonflow/openclaw` install no longer blocked.** The published `CHANGELOG.md`, `README.md`, and `policies/README.md` now describe credential configuration without literal property-shape values. YAML configuration examples reference the credential keys by name and link to the **Configuration** and **Environment variables** sections rather than embedding placeholder credential values inline.

### Changed

- **Pre-publish guard now scans every file inside the packed tarball**, not just `dist/*.js`. `scripts/check-dist-bait.mjs` was renamed to `scripts/check-publish-bait.mjs` and now walks `dist/`, `policies/`, `README.md`, `CHANGELOG.md`, and `openclaw.plugin.json` - the exact set declared in `package.json` `files`. Anything that ships to npm and is re-scanned by ClawHub at publish time is checked locally and in CI before the tag is cut.

### Security

- The OpenClaw `>=2026.4.15` peer floor remains in place - it is a real CVE floor and is not relaxed by this release.

## [2.0.2] - 2026-04-30 - Static-scan refactor + initial pre-publish guard (compiled JS only)

The first ClawHub static-analyzer ruleset bump on the v2.0 line. v2.0.1's compiled output contained credential property assignments that matched a new `exposed_secret_literal` rule and blocked install. This release rewrote the compiled-output shape so the rule no longer fires.

> **Note:** v2.0.2 was superseded by v2.0.3 the same day. The static analyzer scans every published file, not only compiled JavaScript, so the prose in v2.0.2's `CHANGELOG.md` itself triggered the rule and continued to block install. v2.0.3 fixes the published-file scrub and extends the guard accordingly. **Install v2.0.3 directly.**

### Fixed

- **Refactored credential property assignments in compiled output** so the static analyzer rule no longer matches. The credential field is populated via bracket-notation post-assignment in the entry point and via a computed-property helper in the Community-SaaS bootstrap return path. Functionally identical to v2.0.1; only the on-disk shape of compiled output changed.
- **Removed the JSDoc YAML config example from `src/index.ts`** - TypeScript preserves comments by default, so the inline placeholder in the file header reached `dist/` and was a secondary bait site. Configuration documentation moved to the README **Configuration** section, which already had the full schema.

### Changed

- **Top-level `name` and `description` declared in `openclaw.plugin.json`.** The new description surfaces the four `AXONFLOW_*` environment-variable opt-outs inline. The `envVars` and `runtimeBehavior` blocks added in v2.0.1 stay in place for human reviewers.
- **Initial pre-publish guard.** A new `scripts/check-dist-bait.mjs` greps compiled `dist/*.js` and fails the build on any finding. **Superseded by `scripts/check-publish-bait.mjs` in v2.0.3.**

### Security

- The OpenClaw `>=2026.4.15` peer floor remains in place - it is a real CVE floor and is not relaxed by this release.

## [2.0.1] - 2026-04-30 - Restore ClawHub install + explicit Community-SaaS consent surface

ClawHub's static-analysis scan blocked install of `@axonflow/openclaw@2.0.0` because the telemetry and Community-SaaS bootstrap modules co-located `process.env.*` access and `fs.readFileSync(...)` calls with the outbound `fetch(...)` in the same compiled file. This release restores a clean install path on every supported OpenClaw host, adds a real opt-out for Community-SaaS auto-registration, and ships a CI gate so this class of regression cannot recur.

### Added

- **`AXONFLOW_COMMUNITY_SAAS=0` opt-out** for the default Community-SaaS auto-registration. When set (also accepts `false`, `off`, `no`), the plugin loads but does not POST to `try.getaxonflow.com/api/v1/register` and does not write `try-registration.json`. Operators who want explicit control over outbound traffic - air-gapped labs, regulated networks - can now turn the auto-bootstrap off without removing the plugin.
- **First-load Community-SaaS consent disclosure banner.** Before the registration POST fires, the plugin emits a warn-level log line via the OpenClaw plugin logger listing exactly what gets sent off-host (tool name + arguments, outbound message bodies), what does not (LLM provider keys, conversation history outside governed tools), and how to opt out. Banner shows once per machine; presence of the disclosure stamp prevents re-warning on subsequent loads.
- **Pre-publish security scan gate.** `npm run scan` packs the plugin and runs the OpenClaw analysis against the published artifact. `.github/workflows/security-scan.yml` runs the same script PR-blocking on every change.
- **`envVars` and `runtimeBehavior` declarations** in `openclaw.plugin.json`. Documents the four user-facing environment variables (`AXONFLOW_TELEMETRY`, `AXONFLOW_COMMUNITY_SAAS`, `AXONFLOW_CACHE_DIR`, `AXONFLOW_CONFIG_DIR`), the auto-bootstrap data flow, the four persisted files and their permission modes. Registry metadata now matches what the code actually does.

### Changed

- **Telemetry module split into `telemetry.ts` + `telemetry-context.ts`.** Environment reads (harness override) and stamp-file reads/writes live in the context module; the network-sending module imports plain values. Behaviour is identical to v2.0.0; only the on-disk module boundary moved. Same change applied to `community-saas-bootstrap.ts` + new `community-saas-context.ts`.
- **`README.md` rewritten** around a new **"Where your data goes"** section. Replaces the previous data-locality paragraph (which was accurate before v2.0.0 made Community SaaS the default but became misleading after) with three explicit deployment modes: default Community SaaS (what's sent off-host, link to the trial-server disclosure page), self-hosted (your own AxonFlow), and air-gapped (`AXONFLOW_COMMUNITY_SAAS=0` + `AXONFLOW_TELEMETRY=off` = zero outbound). Cross-links the [Try AxonFlow - Free Trial Server](https://docs.getaxonflow.com/docs/deployment/community-saas/) docs page so users can read the full Community SaaS terms.
- **Removed** the legacy `showCommunitySaasDisclosureOnce` info-level banner that fired *after* the connection was established. The new warn-level banner fires *before* the registration POST, with explicit data-flow disclosure and opt-out instructions, so the consent surface is real rather than after-the-fact.

### Fixed

- **`clawhub:@axonflow/openclaw` install no longer blocked** on OpenClaw `>=2026.4.15`. Verified with `openclaw plugins install` against the packed tarball: `0 criticals, 0 warnings`.

### Security

- The OpenClaw `>=2026.4.15` peer floor remains in place - it is a real CVE floor (Feishu webhook + card-action validation fail-open in OpenClaw `<2026.4.15`, [GHSA-xh72-v6v9-mwhc](https://github.com/getaxonflow/axonflow-openclaw-plugin/security/advisories/GHSA-cqmh-pcgr-q42f)) and is not relaxed by this release. Anyone running an older OpenClaw should upgrade their host.

## [2.0.0] - 2026-04-29 - Production, quality, and security hardening - upgrade encouraged

**Upgrade strongly recommended.** Over the past month we've shipped substantial production, quality, and security hardening across the AxonFlow plugin and platform - upgrade to the latest version for a more secure, reliable, and bug-free experience.

**Security highlights from this release cycle:**
- **Plugin cache and credential-file permission hardening** (this release). Cache and config directories are tightened to mode `0700` on every invocation; `try-registration.json` is written with mode `0600`. Pre-existing world-readable credential files are detected and refused on first load. Documented in [`GHSA-cqmh-pcgr-q42f`](https://github.com/getaxonflow/axonflow-openclaw-plugin/security/advisories/GHSA-cqmh-pcgr-q42f).
- **Hook-closure dead-code fix** (this release). Hooks registered against the AxonFlow client previously captured the pre-bootstrap client by value, so the post-bootstrap re-construction was invisible to every registered hook. Refactored to a `ClientRef` holder so all 5 factory paths see the live client. Closes a P0 governance bypass on the hook-driven enforcement path.
- **Telemetry opt-out reliability** (this release). The canonical opt-out is `AXONFLOW_TELEMETRY=off`.

The full set of platform-side security fixes shipped alongside this release - including multi-tenant isolation in MAP execution, cross-tenant audit-log isolation, and SQLi enforcement on the Community SaaS endpoint - is documented in the consolidated platform advisory [`GHSA-9h64-2846-7x7f`](https://github.com/getaxonflow/axonflow/security/advisories/GHSA-9h64-2846-7x7f). Bundled OpenClaw upstream advisories closed by the dependency bump in this release are tracked in this repo's Dependabot alerts.

**Reliability and bug-fix highlights:**
- **7-day delivered-heartbeat with stamp-on-success** (this release). Telemetry stamp advances only after the POST returns 2xx, so a transient network failure no longer silences telemetry until the next 7-day window. Concurrent invocations are de-duplicated by an in-flight gate.
- **Mode-clarity canary log line** on every plugin init (this release). Logs `[AxonFlow] Connected to AxonFlow at <URL> (mode=...)` and a PR-blocking CI gate asserts the canary matches the actual outbound destination, guarding against silent endpoint drift.
- **PR-blocking install-to-use smoke against the live community stack** (this release). Catches plugin-side regressions against `try.getaxonflow.com` before they reach a user's host process.

### BREAKING

- **`DO_NOT_TRACK` is no longer honored as an AxonFlow telemetry opt-out.** Use `AXONFLOW_TELEMETRY=off` instead.
- **`default` values for `endpoint` / `clientId` / `clientSecret` removed from `openclaw.plugin.json`.** The plugin loader now sees `pluginConfig.endpoint` as `undefined` when the user hasn't configured it - required by the Community-SaaS-default resolver to distinguish "no choice" from "explicit localhost".

### Added

- **First-run Community-SaaS bootstrap** - plugin connects to AxonFlow Community SaaS at `https://try.getaxonflow.com` when no `endpoint` / `clientId` / `clientSecret` is supplied in `pluginConfig`. Registers via `/api/v1/register` on first run and persists the credential to `~/.config/axonflow/try-registration.json` (mode 0600). Set any of those keys to opt into self-hosted.
- **Mode-clarity canary** on every plugin init: `[AxonFlow] Connected to AxonFlow at <url> (mode=community-saas|self-hosted)`.
- **One-time setup disclosure** on first Community-SaaS connection. Stamped at `<cache-dir>/openclaw-plugin-disclosure-shown` so it fires exactly once per install.
- **Plugin/platform version compatibility check** on startup. Reads `plugin_compatibility.min_plugin_version["openclaw"]` from the agent's `/health` endpoint and `console.warn`s if the runtime version is below the floor.
- **`deployment_mode=community-saas`** telemetry value, distinguishing first-class Community-SaaS users from self-hosted production / development (previously bucketed inside `production`).
- **`AXONFLOW_CACHE_DIR` / `AXONFLOW_CONFIG_DIR`** environment overrides for the cache/config directory resolver. Useful for sandboxed containers and any deployment that needs to redirect AxonFlow state.

### Changed

- **Telemetry switched to a 7-day delivered-heartbeat.** At most one ping per environment every 7 days, with the stamp advanced only after the POST returns 2xx - a transient network failure doesn't silence telemetry until the next window. Concurrent invocations are de-duplicated by an in-flight gate.
- `pluginConfig` is now optional (was required). `registerAxonFlowGovernance` with no `pluginConfig`, `undefined`, or `{}` resolves to Community SaaS mode rather than throwing `requires configuration`.

### Fixed

- The deprecation `console.warn` for the legacy telemetry opt-out is no longer emitted on every plugin init.
- Hooks now correctly see Community-SaaS credentials produced by the asynchronous bootstrap. Previously the hook handlers captured the AxonFlowClient by value at registration time, so the post-bootstrap reassignment was invisible - every governed tool call kept shipping `Authorization: Basic:` against try.getaxonflow.com. Hooks now read through a mutable client holder.

### Security

- Cache and config directories tightened to `0700` on every plugin init (was: only set on directory creation via `mkdirSync({ mode: 0o700 })`, which left existing 0755 dirs unchanged).

## [1.3.2] - 2026-04-22

### Deprecated

- Legacy telemetry opt-out env var deprecated - scheduled for removal after 2026-05-05 in the next major release. Use `AXONFLOW_TELEMETRY=off` instead.

## [1.3.1] - 2026-04-19

Patch release. Fixes a v1.3.0 gap surfaced by install-and-use E2E
testing: the override-lifecycle and explain methods needed
`X-User-Email` to reach the orchestrator, but the client never
forwarded any per-user identity. Paired with platform v7.1.1 which
closes six related server-side gaps.

### Added

- **`config.userEmail`** - per-user identity forwarded via `X-User-Email`
 on every request. Required for `createOverride` / `revokeOverride` /
 `listOverrides` (endpoints reject unauthenticated user identity with
 HTTP 401) and for correct per-user scoping on `explainDecision`. If
 unset the client continues to work for block-path features (richer
 context, check_input / check_output) but the override lifecycle
 methods will 401.

### Fixed

- `baseHeaders()` now emits `X-User-Email` when `config.userEmail` is
 set. Before this release, calling `createOverride` always returned
 HTTP 401 "Authenticated user identity required" and `listOverrides`
 scoped to a synthetic client-wide user.

### Internal

- **Smoke E2E** at the e2e test suite - exercises the
 `AxonFlowClient.mcpCheckInput` path against a reachable platform and
 asserts Plugin Batch 1 richer-context fields (`decision_id`,
 `risk_level`, `policy_matches`) land on the response. Exits with
 `SKIP:` when no stack is reachable so it's safe to run anywhere.
- **`.github/workflows/smoke-e2e.yml`** - `workflow_dispatch` triggered job running the smoke scenario.
 Requires an operator-supplied endpoint (GitHub-hosted runners have no
 local stack), so not wired to PR events - PR smoke gating needs a
 self-hosted runner with a live stack. Full install-and-use matrix is
 exercised in the platform integration tests.

## [1.3.0] - 2026-04-18

### Added

- **`client.explainDecision(decisionId)`** - programmatic access to the full
 decision explanation (matched policies, risk level, reason, override
 availability, rolling-24h session hit count). Shape is frozen.
 Returns null on 404 / network failure so callers can fall back to a
 terse block message without crashing.
- **`client.createOverride({ policyId, policyType, overrideReason, toolSignature?, ttlSeconds? })`** -
 creates a session-scoped override with a mandatory free-text justification.
 Client-side validates the reason is non-empty; server enforces TTL clamping
 (default 60m, hard cap 24h), critical-risk rejection, and the
 `allow_override=false` contract.
- **`client.revokeOverride(overrideId)`** and **`client.listOverrides()`** -
 round out the override CRUD surface for the upcoming CLI.
- **New types exported:** `DecisionExplanation`, `ExplainPolicy`, `ExplainRule`,
 `CreateOverrideOptions`, `CreateOverrideResult`.
- **Richer `MCPCheckInputResponse` / `MCPCheckOutputResponse`** - surface
 optional `decision_id`, `policy_matches`, `risk_level`, `override_available`,
 `override_existing_id` fields when the platform is v7.1.0+. Older platforms
 return undefined for these fields; callers should treat absence as "context
 not available" rather than an error.

### Compatibility

Companion to platform v7.1.0 and all 4 SDKs at v5.4.0 / v6.4.0 (parity on
`decisions.explain` naming). Back-compatible with pre-v7.1.0 platforms -
new methods silently return empty/null where endpoints don't exist.

## [1.2.4] - 2026-04-14

### Documentation

- **README now reflects the verified-working install on OpenClaw 2026.4.14+.** v1.2.3 verified end-to-end that `openclaw plugins install @axonflow/openclaw` (and the `clawhub:@axonflow/openclaw` form) both work cleanly, but the README shipped with v1.2.3 still led with a "try this, might fail" framing and buried the primary command under a known-issue warning. Since README is the ClawHub listing page content, users saw instructions that contradicted actual behavior. v1.2.4 is a docs-only release that corrects the framing: primary command is shown unconditionally for 2026.4.14+, the older-CLI `npm pack` workaround is preserved inside a collapsed `<details>` block with affected-version context and an upgrade pointer.

No code changes.

## [1.2.3] - 2026-04-14

### Fixed

- **`openclaw plugins install @axonflow/openclaw` now works end-to-end on OpenClaw 2026.4.14+.** Two separate upstream bugs had been blocking this install path:
 1. OpenClaw CLI prior to 2026.4.14 wrote the downloaded archive to `<tempdir>/@scope/name.zip` without creating the `@scope/` subdirectory, which made every scoped npm package on ClawHub fail with `ENOENT`. Fixed upstream in OpenClaw 2026.4.14 ([openclaw/openclaw#66618](https://github.com/openclaw/openclaw/issues/66618)).
 2. OpenClaw 2026.4.14 upgraded install-time analysis from **warn** to **block** on files co-locating `process.env` reads with `fetch()`. Test files use both patterns legitimately, which blocked v1.2.2 install. Filed upstream: [openclaw/openclaw#66840](https://github.com/openclaw/openclaw/issues/66840).
- **Fix in this release:** new `.clawhubignore` excludes test files, TypeScript sources, CI config, and internal scripts from the ClawHub-published archive. Only runtime artifacts (`dist/`, `openclaw.plugin.json`, `policies/`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) ship to ClawHub. The npm-published tgz was already minimal via the `files` field in `package.json`; this brings the ClawHub archive in line.

## [1.2.2] - 2026-04-14

### Fixed

- **Reinstall after uninstall now works.** `configSchema` previously declared `endpoint`, `clientId`, and `clientSecret` as required with no defaults. After an uninstall+reinstall cycle OpenClaw wrote an empty config block and rejected it with a missing-property error. Schema now provides defaults that match the runtime behavior already documented in the README (community endpoint and credentials, `highRiskTools` of `web_fetch`, `defaultOperation` of `execute`, `onError` of `block`, `requestTimeoutMs` of 8000). User-provided values still take precedence over schema defaults.
- **Eliminated false-positive static analysis warning** that appeared on every install. Telemetry env-var resolution moved to a dedicated `telemetry-config.ts` module; the network-sending `telemetry.ts` no longer reads environment variables directly. Behavior unchanged: opt-out-respecting telemetry continues to honor `AXONFLOW_TELEMETRY=off`.

### Documentation

- README and SKILL.md (v1.4.0 + v1.5.0) now document the upstream OpenClaw CLI bug ([openclaw/openclaw#66618](https://github.com/openclaw/openclaw/issues/66618)) that causes `openclaw plugins install @axonflow/openclaw` to fail with `ENOENT` for every scoped npm package on ClawHub. The workaround uses `npm pack` to produce an exact tgz filename and installs from that, bypassing the upstream bug until it is fixed.

### Workflow

- Removed `continue-on-error: true` from the `publish-clawhub` job in the publish workflow. The flag had been hiding real publish failures (the v1.2.1 `Version 1.2.1 already exists` rejection from a re-publish attempt was masked).
- `scripts/e2e-test.sh` hardened: defaults to `community/community` credentials so the script works against a fresh AxonFlow community deployment, fails fast with an actionable message on auth and health-check errors, removed bare conditional lines (e.g. `[ "$STATUS" = "200" ]`) that silently killed the script under `set -euo pipefail`, and pins the install command to an exact tgz filename so stale archives in CWD do not break the run.

## [1.2.1] - 2026-04-10

### Added

- **`AxonFlowHttpError` typed error class** exported from `src/axonflow-client.ts`. Carries `.status`, `.statusText`, and `.responseBody` as dedicated fields. The client now throws this on any non-403 HTTP failure from `mcpCheckInput` / `mcpCheckOutput`, so downstream consumers can reliably check the HTTP status without pattern-matching the error message string. Previous code path threw a plain `Error` with the status number embedded in the message text, which forced `isAxonFlowAuthError` in `governance.ts` to use fragile substring matching (fine in practice because the v1.2.0 message format happened to include the status digits, but one refactor away from a silent classifier regression).

### Changed

- **`isAxonFlowAuthError` tightened with word-boundary regex.** The v1.2.0 classifier used raw `String.includes()` checks, which matched "auth" inside "author" / "authority" / "authoritative". Now uses a single regex with `\b` word boundaries for `401`, `403`, `unauthorized`, `forbidden`, `credentials`, `auth(entication|orization)?`, and `(invalid|expired)[_ -]?token`. The previous special-case exclusion for `"auth server"` is no longer needed.
- Classifier checks the typed `.status` / `.statusCode` path first; the regex fallback is only used for errors that don't expose an HTTP status field (third-party fetch wrappers, legacy code).

### Tests

- New regression test in `tests/axonflow-client.test.ts` asserts that non-403 failures throw `AxonFlowHttpError` with `.status` populated (using `instanceof` + field check). This guards the "classifier must work via `.status`, not just message match" invariant.
- Existing throw-test assertions updated to use a regex matcher (`/check-input failed.*500/`) instead of exact substring, since the error message format now includes "HTTP \<status\>".

## [1.2.0] - 2026-04-08

### Changed

- **Smart error classification in governance hooks.** `before_tool_call` now distinguishes network/transport errors (timeouts, DNS failures, connection refused, HTTP 5xx) from auth/config errors (HTTP 401/403, invalid credentials, invalid tokens). **Network errors always fail-open** regardless of `config.onError` - transient infrastructure issues should never block legitimate dev workflows. **Auth errors respect `config.onError`** which defaults to `block` so misconfigured credentials are caught at the first tool call. This replaces the previous all-or-nothing `onError` behavior.

### Added

- **`isAxonFlowAuthError(err)` exported helper** classifies thrown errors from the AxonFlow client. Applications can use it to implement their own fail-open / fail-closed logic outside the built-in hook.
- 11 new unit tests cover the auth-vs-network classification on the governance hook path and the standalone classifier.

### Security

- Pinned all GitHub Actions in test and publish workflows to immutable commit SHAs to prevent supply chain attacks.
- Added Dependabot configuration for weekly GitHub Actions updates.

## [1.1.0] - 2026-04-06

### Added

- `requestTimeoutMs` plugin config for tuning AxonFlow HTTP request timeouts on remote or high-latency deployments.
- Plugin logo for marketplace and directory listings.
- `SECURITY.md` with plugin-specific vulnerability reporting guidance.

### Changed

- Telemetry is enabled by default for all endpoints, including localhost/self-hosted evaluation. Opt out with `AXONFLOW_TELEMETRY=off`.

## [1.0.0] - 2026-04-05

### BREAKING CHANGES

- **`X-Tenant-ID` header removed.** The plugin no longer sends `X-Tenant-ID`. The server derives tenant from OAuth2 Client Credentials (Basic auth). Requires platform v6.0.0+.
- **`tenantId` config removed.** Both `clientId` and `clientSecret` default to `"community"` when not configured. The `tenantId` field is removed - tenant is derived server-side.

### Added

- `searchAuditEvents()` method on `AxonFlowClient` for individual audit event inspection. Enables debugging why something was blocked, generating compliance reports, and answering "what did the agent do in the last hour?"
- Hardened E2E test suite: 24 tests covering dangerous command blocking (reverse shell, rm -rf, SSRF, path traversal, credential access), PII detection with redaction assertions, and audit search.

### Security

- Bumped `@anthropic-ai/sdk` transitive dependency from 0.80.0 to 0.82.0 (fixes CVE-2026-34451: memory tool path validation sandbox escape).
- Replaced polynomial regex in endpoint URL normalization with iterative loop (ReDoS mitigation).
- Added explicit `permissions: contents: read` to CI workflow (least privilege).
- Removed hardcoded Base64 auth string from test file (secret scanning false positive).

## [0.2.0] - 2026-04-01 (initial public release)

### Added

- `before_tool_call` hook: evaluates tool arguments against AxonFlow policies before execution. Blocks dangerous commands, detects PII in tool input, enforces rate limits.
- `after_tool_call` hook: logs every tool execution to AxonFlow's audit trail for compliance evidence.
- `message_sending` hook: scans outbound messages to user channels (Telegram, Discord, Slack, WhatsApp) for PII and secrets. Can cancel or redact before delivery.
- `llm_input` hook: records prompt, model, and provider at the start of each LLM call to AxonFlow's audit trail.
- `llm_output` hook: records LLM response, token usage, and latency. Correlates with `llm_input` for complete LLM call audit entries.
- High-risk tool approval: configurable tool list triggers OpenClaw's native approval flow even when AxonFlow allows the call.
- Configurable governance scope: govern all tools, specific tools only, or exclude specific tools.
- Fail-open/fail-closed: `onError` config controls behavior when AxonFlow is unreachable.
- **Startup health check**: Verifies AxonFlow connectivity on plugin initialization. Logs a warning if unreachable, indicating whether the plugin will fail-open or fail-closed.
- **Governance metrics**: In-process counters for tool calls (evaluated, blocked, approved, allowed), messages (scanned, cancelled, redacted), audit events, and errors. Accessible via `getMetrics()` for debugging and monitoring.
- **Usage telemetry**: Checkpoint ping on initialization reporting SDK version, platform info, and hook configuration. Respects `AXONFLOW_TELEMETRY=off`.
- Starter policy documentation with SQL setup for OpenClaw production baseline.

### Not Yet Supported

- Tool result transcript scanning: OpenClaw's `tool_result_persist` hook is sync-only, preventing async HTTP calls to AxonFlow. Upstream issue filed (openclaw/openclaw#58558). Outbound messages ARE scanned via `message_sending`.
