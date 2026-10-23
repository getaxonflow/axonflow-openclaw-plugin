# Hosted paid-first runtime proof

This suite proves the OpenClaw part of getaxonflow/axonflow-enterprise#4487 through deployed runtime surfaces.

It performs these checks:

1. Reads authenticated billing status for an unpaid hosted test tenant.
2. Sends a governed request through the compiled `AxonFlowClient`.
3. Verifies the request receives structured HTTP 402 and the client automatically creates a tenant-bound Stripe Checkout session.
4. Verifies the client surfaces that Checkout URL once without asking for a tenant ID or license token.
5. Installs the same build in OpenClaw, dispatches a real shell tool, and proves the unpaid call is blocked before the command executes.
6. Verifies the $9.99 price, approved limits, and required Hosted Starter feature list returned by the deployment.
7. Creates an authenticated Stripe Customer Portal session for an active subscriber.
8. Sends the same governed request with the active paid test tenant and proves it reaches the policy decision surface.

The run creates a Checkout session but does not complete payment. Credentials and the ephemeral Checkout URL stay out of tracked evidence. The evidence records only status fields, the Checkout host, and a SHA-256 digest of the URL.

## Prerequisites

- The #4486 workflow and #4488 security gates are accepted and enabled on the target deployment.
- A deployed endpoint containing the #4487 server changes.
- One unpaid hosted test tenant and one active paid hosted test tenant.
- OpenClaw on `PATH` with a configured model credential.
- `curl`, `jq`, Node.js, npm, and `timeout`.

## Production run

```bash
AXONFLOW_HOSTED_E2E_CONFIRM=hosted-paid-first \
AXONFLOW_HOSTED_E2E_TARGET=production \
AXONFLOW_ENDPOINT=https://try.getaxonflow.com \
AXONFLOW_UNPAID_CLIENT_ID='<unpaid test client id>' \
AXONFLOW_UNPAID_CLIENT_SECRET='<unpaid test client secret>' \
AXONFLOW_PAID_CLIENT_ID='<paid test client id>' \
AXONFLOW_PAID_CLIENT_SECRET='<paid test client secret>' \
bash runtime-e2e/hosted-paid-first/test.sh
```

For a staging deployment, set `AXONFLOW_HOSTED_E2E_TARGET=staging` and provide its HTTPS endpoint. If Stripe uses nonstandard test hostnames, set `AXONFLOW_EXPECTED_CHECKOUT_HOST` and `AXONFLOW_EXPECTED_PORTAL_HOST` to the exact hosts.

An unarmed invocation exits with `SKIP`. A certification run must use the confirmation value and finish with `PASS`; a skipped run is not release evidence.
