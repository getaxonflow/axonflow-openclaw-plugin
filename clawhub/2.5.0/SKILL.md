---
name: governance-policies
description: AxonFlow plugin setup for OpenClaw — install, connect, and explore starter governance policies.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: agent-security, approvals, audit, compliance, explainability, governance, human-in-the-loop, llm-governance, mcp, openclaw, overrides, pii, policies, safety, security, sqli
---

# AxonFlow Governance for OpenClaw

Setup guide for the AxonFlow governance plugin.

## Install

```bash
openclaw plugins install @axonflow/openclaw@2.6.4
```

Requires OpenClaw 2026.5.22+ and `@axonflow/openclaw` 2.6.4+.

## What you can do with it

| Feature | Read more |
|---|---|
| 80+ built-in governance policies | [Policies](https://docs.getaxonflow.com/docs/policies/overview/) |
| Decision explainability | [Explainability](https://docs.getaxonflow.com/docs/governance/explainability/) |
| Session overrides | [Overrides](https://docs.getaxonflow.com/docs/governance/overrides/) |
| PII detection and redaction | [Compliance](https://docs.getaxonflow.com/docs/compliance/) |
| Decision history | [Decisions](https://docs.getaxonflow.com/docs/governance/decisions/) |
| Compliance and audit trail | [Compliance](https://docs.getaxonflow.com/docs/compliance/) |
| Pricing and tiers | [Pricing](https://getaxonflow.com/pricing/) |

## Connect to AxonFlow

Configure `pluginConfig` in your `openclaw.config.yaml` with `endpoint`, `clientId`, and `clientSecret`. Store credentials in a secret manager and do not commit them to source control. See [Configuration reference](https://docs.getaxonflow.com/docs/integration/openclaw/).

Setup guides:
- [Self-Hosted Deployment](https://docs.getaxonflow.com/docs/deployment/self-hosted/) (recommended for production)
- [Getting Started](https://docs.getaxonflow.com/docs/getting-started/)

## Plugin Pro

| | Free | Pro |
|---|---|---|
| Governed events | 200/day | 2,000/day |
| Audit retention | 3 days | 30 days |
| Custom policies | 4 | 50 |
| HITL approvals | 2/week | 20/week |
| LLM cost pre-flight | — | Yes |

$9.99 one-time, 90-day license, no auto-renewal. [Get Pro](https://getaxonflow.com/pricing/)

## Starter policies

Ready-to-use templates: [policies/](https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies)

## Reference

- [AxonFlow docs](https://docs.getaxonflow.com/)
- [Plugin reference](https://docs.getaxonflow.com/docs/integration/openclaw/)
- [Plugin GitHub](https://github.com/getaxonflow/axonflow-openclaw-plugin)
- [Platform GitHub](https://github.com/getaxonflow/axonflow)

## License

Plugin: MIT. Platform: BSL 1.1. See [licensing](https://docs.getaxonflow.com/docs/deployment/licensing/).
