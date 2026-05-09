---
name: governance-policies
description: AxonFlow governance for OpenClaw — author policies, explain decisions, and handle approvals. Self-host AxonFlow for production workloads.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: agent-security, approvals, audit, compliance, explainability, governance, human-in-the-loop, llm-governance, mcp, openclaw, overrides, pii, policies, safety, security, sqli
---

# AxonFlow Governance Policies for OpenClaw

This skill helps an OpenClaw deployment use AxonFlow governance. Use it when installing the plugin, authoring policies, or wiring up decision explainability and approval workflows.

## Install

```bash
openclaw plugins install @axonflow/openclaw@latest
```

Requires OpenClaw 2026.4.15+ and `@axonflow/openclaw` 2.4.0+.

## What you can do with it

| Feature | Read more |
|---|---|
| Author your own governance policies | [Policy Authoring](https://docs.getaxonflow.com/docs/governance/policies/) |
| Understand the reasoning behind a governance decision | [Explainability](https://docs.getaxonflow.com/docs/governance/explainability/) |
| Request a time-bounded exception | [Session Overrides](https://docs.getaxonflow.com/docs/governance/overrides/) |
| Compliance + audit | [Compliance docs](https://docs.getaxonflow.com/docs/compliance/) |
| Pricing + tiers | [Pricing](https://getaxonflow.com/pricing/) |

## Connect the plugin to AxonFlow

```yaml
# openclaw.config.yaml
plugins:
  "@axonflow/openclaw":
    endpoint: http://your-axonflow-instance:8080
    clientId: your-client-id
    clientSecret: your-secret
    userEmail: you@example.com
```

Setup guides:
- [Self-Hosted Deployment](https://docs.getaxonflow.com/docs/deployment/self-hosted/) (recommended for production)
- [Getting Started](https://docs.getaxonflow.com/docs/getting-started/)
- [Configuration reference](https://docs.getaxonflow.com/docs/configuration/)

## Starter policies

Ready-to-use templates for the OpenClaw stack: [policies/](https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies).

## Reference

- [AxonFlow docs](https://docs.getaxonflow.com/)
- [Plugin reference](https://docs.getaxonflow.com/docs/plugins/openclaw/)
- [Plugin GitHub](https://github.com/getaxonflow/axonflow-openclaw-plugin)
- [Platform GitHub](https://github.com/getaxonflow/axonflow)

## License

Plugin code under BSL 1.1. See [licensing](https://docs.getaxonflow.com/docs/licensing/).
