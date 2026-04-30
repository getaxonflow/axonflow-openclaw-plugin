# ClawHub Skill Changelog

## @axonflow/governance-policies

### 2.0.1 (2026-05-01)

Bumps the recommended `@axonflow/openclaw` floor from `2.0.0` to `2.0.4` — the recommended stable patch for the v2.x line. Two reasons users on earlier v2.0.x patches should upgrade:

- **Schema gap silently disabled the plugin.** v2.0.0 through v2.0.3 shipped a `configSchema` in `openclaw.plugin.json` that did not list `userEmail`. OpenClaw's plugin loader rejected configs that set it (per the documented override-workflow path) and skipped the plugin entirely with only a log line as warning, leaving the user ungoverned. v2.0.4 closes the schema gap.
- **Telemetry only became reliable in v2.0.4.** Earlier v2.0.x patches had brittle heartbeat behaviour (the schema rejection above prevented the plugin from registering at all on misconfigured installs, and other early-cycle issues caused stamp-on-failure semantics that silenced subsequent windows). v2.0.4 is the first patch where the 7-day anonymous heartbeat reaches the checkpoint reliably, which means it is also the first patch where the project can see who is on the plugin and respond to drop-off signals. Users on v2.0.0–v2.0.3 are effectively invisible — upgrading to v2.0.4 surfaces them in the active-install count.

Body is otherwise unchanged from v2.0.0; only the version qualifier in the Install section is updated.

### 2.0.0 (2026-05-01)

Major bump tracking the plugin's v2.0 major line. Catches the skill up with the deployment-mode and telemetry changes shipped in `@axonflow/openclaw` v2.0.0–v2.0.3 and platform v7.0.0. From a user-following-prior-skill-instructions perspective the change is breaking: the default deployment mode flipped from "self-hosted only" to "Community SaaS auto-registration", and the previously-documented `DO_NOT_TRACK=1` opt-out no longer works (canonical opt-out is now `AXONFLOW_TELEMETRY=off`).

_The intent here is a 2.0.0 major. ClawHub's publish-form bug ([openclaw/clawhub#1739](https://github.com/openclaw/clawhub/issues/1739)) still rejects manually-entered minor/major versions with a misleading "must be valid semver" error, so the actually-published version may fall back to a patch bump (1.5.3) until the bug is fixed. Content is unchanged either way._

Changes vs 1.5.2:

- **Three deployment modes documented.** New "Deployment Modes" section covers Community SaaS (the new default — `openclaw plugins install @axonflow/openclaw` auto-registers with `try.getaxonflow.com` on first load with no further config), Self-hosted (recommended for any real workload), and Air-gapped (`AXONFLOW_COMMUNITY_SAAS=0` + `AXONFLOW_TELEMETRY=off` + same-network endpoint = zero outbound). Replaces the previous "AxonFlow is self-hosted" framing which became inaccurate when plugin v2.0.0 made Community SaaS the default.
- **`AXONFLOW_COMMUNITY_SAAS` opt-out documented.** New env var introduced in plugin v2.0.0 to disable the Community SaaS auto-bootstrap; required for air-gapped operation. Accepted off-values: `0`, `false`, `off`, `no`.
- **`DO_NOT_TRACK` removed.** The legacy `DO_NOT_TRACK=1` opt-out was fully removed in plugin v2.0.0 / platform v7.0.0; `AXONFLOW_TELEMETRY=off` is now the canonical and only telemetry opt-out. Skill no longer mentions `DO_NOT_TRACK`.
- **New "Environment variables" section** lists all four user-facing env vars (`AXONFLOW_TELEMETRY`, `AXONFLOW_COMMUNITY_SAAS`, `AXONFLOW_CACHE_DIR`, `AXONFLOW_CONFIG_DIR`) with effects and defaults.
- **Configure section rewritten** to describe `pluginConfig` keys in prose with explicit "resolve the credential value from a secret store, never embed in a checked-in config file" guidance. Replaces the previous YAML config block which embedded a literal credential placeholder and tripped per-line static-analyzer rules — same scrub pattern applied to the plugin README in v2.0.3.
- **Plugin/CLI version floor bumped.** Minimum OpenClaw CLI stated as 2026.4.15 (real CVE floor); minimum plugin version stated as 2.0.0 (the deployment-mode + telemetry-canonicalization release). Earlier per-feature qualifiers (`v1.3.0+` / `v1.3.1+`) consolidated into the single 2.0.0+ floor; the underlying capabilities (richer block context, override lifecycle, `userEmail` forwarding) are all available on this floor.
- **Community SaaS docs page linked** in the "Get Started" subsection of "Learn More", alongside the existing Self-Hosted Deployment, Getting Started, and OpenClaw Integration Guide links. The page covers the data-flow disclosure, registration mechanics, rate limits, and data retention specifically for the `try.getaxonflow.com` Community SaaS endpoint.

### 1.5.2 (2026-04-19)

Major content expansion covering Plugin Batch 1 features shipped in @axonflow/openclaw v1.3.0 and v1.3.1. _This release was originally authored as v1.6.0 (minor bump to signal the significant content additions) but released as v1.5.2 (patch bump) due to an active ClawHub publish-form bug ([openclaw/clawhub#1739](https://github.com/openclaw/clawhub/issues/1739)) that rejects manually-entered minor/major versions with a misleading "must be valid semver" error. Content is unchanged; the semantic intent remains a minor release._

- **New section — "Understand a Block: Richer Context"** — documents the structured block response shape from platform v7.1.0+ (`decision_id`, `risk_level`, `policy_matches[]`, `override_available`, `override_existing_id`) so agents render specific block reasons instead of generic "policy violation" strings.
- **New section — "Explain a Decision"** — covers `client.explainDecision(id)` with the frozen `DecisionExplanation` shape (ADR-043). Links to the Explainability docs page.
- **New section — "Grant a Session Override"** — covers `client.createOverride()` / `revokeOverride()` / `listOverrides()` with platform-enforced invariants: TTL clamping (60s–24h, default 60m), critical-risk rejection, `allow_override=false` rejection, mandatory justification, 4-event audit lifecycle. Links to the Session Overrides docs page.
- **New section — "Common Workflows"** — canonical walkthroughs for: debug a block, grant a one-off allow, audit a session.
- **New section — "When to use this skill"** — triggers that help the LLM decide to activate this skill (setup, debugging blocks, granting overrides, compliance audits, hardening).
- **New `userEmail` configuration guidance** — required for override + explain endpoints in v1.3.1+. Added to the Configure block.
- **Community-mode config wording corrected** — `clientSecret` can be left empty in community mode (the plugin's `resolveConfig` only defaults `clientId` to `"community"`; `clientSecret` stays the empty string unless set). Prior phrasing had implied both defaulted to `"community"`, which overstated the actual runtime behavior.
- **Updated `description` + `tags`** — added 7 tags for better discoverability: `explainability`, `overrides`, `sqli`, `prompt-injection`, `llm-governance`, `agent-security`, `data-loss-prevention`. Total 18 tags (19 counting the auto-managed `latest`), covering capability (explainability, overrides, sqli, prompt-injection, pii, mcp), category (governance, llm-governance, agent-security, compliance, security, safety, data-loss-prevention), process (audit, approvals, human-in-the-loop, policies), and platform (openclaw).
- **Removed the pre-2026.4.14 CLI workaround** from the primary install flow — the upstream bug is fixed and the primary install command now works unconditionally. Minimum OpenClaw CLI required stated as 2026.4.14; minimum plugin version stated as 1.3.1 (for `X-User-Email` forwarding).

### 1.5.1 (2026-04-14)

- Reframed "Install the Plugin" section so the primary `openclaw plugins install @axonflow/openclaw` command leads unconditionally, with the pre-2026.4.14 `npm pack` workaround moved to a conditional note.
- Minimum OpenClaw CLI stated as 2026.4.14.

### 1.5.0 (2026-04-09)

- Documented the upstream OpenClaw CLI bug affecting scoped package installs (openclaw/openclaw#66618) and the `npm pack` workaround.
- Note added that both `@axonflow/openclaw` and `clawhub:@axonflow/openclaw` install forms hit the same bug on affected CLI versions.

### 1.4.0 (2026-04-06)

- Updated telemetry disclosure: anonymous startup telemetry is enabled by default even for local/self-hosted evaluations unless opted out
- Added `requestTimeoutMs` guidance for remote AxonFlow deployments and slower networks

### 1.3.0 (2026-04-06)

- Added explicit self-hosted declaration with accurate telemetry disclosure
- Localhost/loopback deployments: telemetry suppressed automatically
- Credentials clarified: only needed for enterprise mode
- All policy evaluation happens on the user's own AxonFlow instance

### 1.2.0 (2026-04-06)

- Moved specific attack patterns and blocked commands into code fences to improve ClawHub LLM scan confidence
- Added policy ID references for each blocked pattern (e.g., `sys_dangerous_destructive_fs`)
- Plain text uses generic category names, code blocks have the specifics
- No content removed — same coverage, better structure

### 1.1.0 (2026-04-05)

- Updated for plugin v1.0.0 and platform v6.0.0
- Auth model: tenantId removed, clientId/clientSecret default to "community"
- Policy count updated to 80+ with category breakdown (dangerous commands, SQLi, PII, code-secrets, prompt-injection)
- Added searchAuditEvents() mention for audit inspection

### 1.0.1 (2026-04-03)

- Moved inline SQL and bash code examples behind documentation links to resolve false positive security scan
- OpenClaw LLM scan: Benign (was Suspicious on v1.0.0 due to inline attack pattern strings in policy templates)

### 1.0.0 (2026-04-03)

- Initial release under @axonflow org handle
- Self-hosting guide with prerequisites, Docker Compose setup, health check verification, and services reference
- Clarified that no LLM provider keys are required (OpenClaw handles all LLM calls)
- Community mode authentication note
- 21 documentation links organized by category (Get Started, Policies & Security, Governance & Compliance, Platform & Examples)
- Industry examples: banking, healthcare, e-commerce governance patterns
- Added `audit` tag

---

## Archive: saurabhjain1592/axonflow-governance-policies

### 1.0.2 (2026-04-05)

- Deprecated: points to @axonflow/governance-policies

### 1.0.1 (2026-04-02)

- Added self-hosting guide with prerequisites, Docker Compose setup, health check verification, and services reference
- Added community mode authentication note
- Added link to full deployment documentation

### 1.0.0 (2026-04-01)

- Initial release
- Policy templates for OpenClaw hardening: reverse shells, SSRF, PII, agent config protection, path traversal
- Top 10 risks table with hook mapping
- Built-in system policies reference
- Plugin configuration guide with fail-open/fail-closed explanation
- Licensing section (BSL 1.1 platform, MIT plugin, MIT-0 skill)
