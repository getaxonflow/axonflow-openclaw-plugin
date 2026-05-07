---
name: axonflow-governance
description: Policy enforcement, approval gates, and audit trails for OpenClaw — govern tool inputs before execution, scan outbound messages for PII/secrets, and record agent activity for review and compliance.
homepage: https://docs.getaxonflow.com/docs/integration/openclaw/
tags: agent-security, governance, audit, compliance, llm-governance, openclaw, policy-enforcement, pii, prompt-injection, mcp
primaryEnv: AXONFLOW_LICENSE_TOKEN
requires:
  env:
    - AXONFLOW_ENDPOINT
    - AXONFLOW_TELEMETRY
    - AXONFLOW_COMMUNITY_SAAS
    - AXONFLOW_CACHE_DIR
    - AXONFLOW_CONFIG_DIR
    - AXONFLOW_LICENSE_TOKEN
    - AXONFLOW_RECOVERY_TIMEOUT_MS
    - AXONFLOW_UPGRADE_URL
metadata:
  openclaw:
    config:
      requiredEnv: []
      optionalEnv:
        - AXONFLOW_ENDPOINT
        - AXONFLOW_TELEMETRY
        - AXONFLOW_COMMUNITY_SAAS
        - AXONFLOW_CACHE_DIR
        - AXONFLOW_CONFIG_DIR
        - AXONFLOW_LICENSE_TOKEN
        - AXONFLOW_RECOVERY_TIMEOUT_MS
        - AXONFLOW_UPGRADE_URL
      primaryCredential: AXONFLOW_LICENSE_TOKEN
---

# AxonFlow Governance for OpenClaw — plugin manifest declaration

This file declares the plugin's environment-variable metadata for ClawHub's registry parser. All runtime documentation — install steps, configuration reference, deployment paths, Pro tier activation, recovery flows, security posture — lives in [README.md](README.md).

The standalone `governance-policies` skill (separately published to ClawHub via the web UI from `clawhub/<version>/SKILL.md`) is a different artifact: an in-OpenClaw teaching surface that explains how to USE this plugin from a model's perspective. This `SKILL.md` at the package root exists purely so ClawHub's plugin-ingestion parser indexes the env-var declarations into the registry's `capabilities` block (the schema landed in `clawhub@0.7.0`, 2026-02-16, parsing `requires.env` and `metadata.openclaw.config` from frontmatter).

The same env-var set is the authoritative declaration in [`openclaw.plugin.json`](openclaw.plugin.json) `envVars` block and the [`README.md`](README.md) `## Environment variables` table; all three surfaces stay in lockstep via the [`manifest-envvars-coverage`](.github/workflows/manifest-envvars-coverage.yml) CI gate which fails any PR that drifts them.
