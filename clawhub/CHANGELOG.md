# ClawHub Skill Changelog

## @axonflow/governance-policies

### 1.6.0 (2026-04-19)

Major content expansion covering Plugin Batch 1 features shipped in @axonflow/openclaw v1.3.0 and v1.3.1.

- **New section — "Understand a Block: Richer Context"** — documents the structured block response shape from platform v7.1.0+ (`decision_id`, `risk_level`, `policy_matches[]`, `override_available`, `override_existing_id`) so agents render specific block reasons instead of generic "policy violation" strings.
- **New section — "Explain a Decision"** — covers `client.explainDecision(id)` with the frozen `DecisionExplanation` shape (ADR-043). Links to the Explainability docs page.
- **New section — "Grant a Session Override"** — covers `client.createOverride()` / `revokeOverride()` / `listOverrides()` with platform-enforced invariants: TTL clamping (60s–24h, default 60m), critical-risk rejection, `allow_override=false` rejection, mandatory justification, 4-event audit lifecycle. Links to the Session Overrides docs page.
- **New section — "Common Workflows"** — canonical walkthroughs for: debug a block, grant a one-off allow, audit a session.
- **New section — "When to use this skill"** — triggers that help the LLM decide to activate this skill (setup, debugging blocks, granting overrides, compliance audits, hardening).
- **New `userEmail` configuration guidance** — required for override + explain endpoints in v1.3.1+. Added to the Configure block.
- **Community-mode config wording corrected** — `clientSecret` can be left empty in community mode (the plugin's `resolveConfig` only defaults `clientId` to `"community"`; `clientSecret` stays the empty string unless set). Prior phrasing had implied both defaulted to `"community"`, which overstated the actual runtime behavior.
- **Updated `description` + `tags`** — added `explainability`, `overrides`, `decision-audit`, `hitl` for better discoverability.
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
