# ClawHub Skill Changelog

## @axonflow/governance-policies

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
