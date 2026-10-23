# Hosted paid-first OpenClaw runtime result

Status: **STAGING PARTIAL, CERTIFICATION BLOCKED**

Verified on 23 October 2026:

- enterprise Agent candidate `11.2.0-rc.4487.4f0d1973a` is running in the isolated Community SaaS staging stack;
- staging health returned HTTP 200 with that candidate version;
- unauthenticated POSTs to billing status, Checkout, and Portal returned HTTP 401 instead of 404, proving that all three routes are registered;
- the running task injects the Stripe test API key and webhook signing secret through AWS Secrets Manager references;
- paid enforcement, acceptance values, price, governed-event allowance, and burst remain safely disabled;
- a dedicated unpaid staging tenant is stored in `axonflow/community-saas-staging/hosted-paid-first-e2e` without tracked credential values;
- `run-from-aws-secret.sh` rejects the incomplete credential bundle before execution and does not print secret values.

A complete staging or production certification run still requires all of the following:

- acceptance of the #4486 workflow gate;
- acceptance of the #4488 security gate;
- public DNS for `try-staging.getaxonflow.com` pointing at the active staging load balancer;
- Stripe test-mode activation of a dedicated paid staging tenant through the deployed webhook path;
- the complete paid and unpaid credential bundle in Secrets Manager.

Production still runs the prior server image and returns 404 for the billing routes.
No production result is claimed until `test.sh` completes with `PASS` and its
sanitized `summary.json` is reviewed.
