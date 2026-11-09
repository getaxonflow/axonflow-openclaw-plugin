---
name: governance-policies
description: AxonFlow plugin setup for OpenClaw — install, activate Hosted Starter, or connect a self-hosted deployment.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: agent-security, approvals, audit, compliance, explainability, governance, human-in-the-loop, llm-governance, mcp, openclaw, overrides, pii, policies, safety, security, sqli
---

# AxonFlow Governance for OpenClaw

Setup guide for the AxonFlow governance plugin.

## Install

```bash
openclaw plugins install @axonflow/openclaw@2.10.4
```

Requires OpenClaw 2026.6.6+ and `@axonflow/openclaw` 2.10.4+.

## What you can do with it

| Feature | Read more |
|---|---|
| 80+ built-in governance policies | [Policies](https://docs.getaxonflow.com/docs/policies/overview/) |
| Decision explainability | [Explainability](https://docs.getaxonflow.com/docs/governance/explainability/) |
| Human approval gates | [Human in the loop](https://docs.getaxonflow.com/docs/governance/human-in-the-loop/) |
| PII detection and redaction | [Compliance](https://docs.getaxonflow.com/docs/compliance/) |
| Decision history and audit trail | [Decisions](https://docs.getaxonflow.com/docs/governance/decisions/) |
| Hosted Starter | [Pricing and purchase](https://getaxonflow.com/saas-pricing/) |

## Activate Hosted Starter

Hosted Starter is $9.99 USD per month for one verified organization. The verified account shows the current allowances before payment.

1. Visit [Hosted Starter pricing](https://getaxonflow.com/saas-pricing/), verify your email, review the account-bound plan, and complete secure Checkout.
2. Run the link script from OpenClaw's installed extension directory:

```bash
node "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/extensions/axonflow-governance/bin/axonflow-openclaw-link.mjs"
```

3. Enter the displayed 10-character code in the Portal, restart OpenClaw, and make a governed call.

The client creates its credential locally; the browser never displays it. Unlinked or unpaid Hosted calls remain blocked. Use Hosted Starter for early exploration only, not production, regulated, personal, or other sensitive data.

## Connect a self-hosted deployment

Configure `pluginConfig` with your AxonFlow `endpoint`, `clientId`, and `clientSecret`. Store credentials in a secret manager and do not commit them to source control. See the [OpenClaw configuration reference](https://docs.getaxonflow.com/docs/integration/openclaw/).

Setup guides:
- [Self-Hosted Deployment](https://docs.getaxonflow.com/docs/deployment/self-hosted/) (recommended for production)
- [Getting Started](https://docs.getaxonflow.com/docs/getting-started/)
- [Enterprise](https://docs.getaxonflow.com/docs/deployment/community-to-enterprise-migration/)

## Starter policies

Ready-to-use templates: [policies/](https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies)

## Reference

- [AxonFlow docs](https://docs.getaxonflow.com/)
- [Plugin reference](https://docs.getaxonflow.com/docs/integration/openclaw/)
- [Plugin GitHub](https://github.com/getaxonflow/axonflow-openclaw-plugin)
- [Platform GitHub](https://github.com/getaxonflow/axonflow)

## License

Plugin: MIT. Platform: BSL 1.1. See [licensing](https://docs.getaxonflow.com/docs/deployment/licensing/).
