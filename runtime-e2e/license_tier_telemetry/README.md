# Runtime E2E - `license_tier` on the usage heartbeat (#3619)

The heartbeat now reports the licence tier the **platform** says it is running under, read from the `tier` key of the `/health` response `src/telemetry.ts` already fetches for `platform_version`. This test proves that field through the shipped code rather than a reimplementation of it.

## Prereqs

- Node 20+ and `python3` on `$PATH`
- `npm ci` (the suite and the gate both need `node_modules`)

## What it asserts

**Stage 1a - behaviour suite** (the `license_tier` block in `tests/telemetry.test.ts`). Every tier the platform can answer with reaches the wire byte-for-byte unchanged, including the lowercase `community` default, the transient `starting`, and a tier this build has never heard of. Every way the probe can fail - unreachable, non-2xx, unparseable body, a body that is null, an array, a string or a number, and a `tier` that is absent, blank, or of the wrong type - omits the key entirely while the heartbeat still ships. One case pins `license_tier`, `deployment_mode` and `endpoint_type` to three different values so no pair can be quietly conflated, and every case asserts exactly one `GET /health`, because a second request would make this a new data collection rather than a new field.

**Stage 1b - mutation gate** (`tests/telemetry-license-tier-mutation-gate.sh`). Plants a defect in `src/telemetry.ts` for each property above - field never sent, omission replaced by a literal `"unknown"`, string-type check replaced by coercion, non-2xx guard neutered, length cap raised, client-side normalisation introduced, a second `/health` request - and requires the suite to go red for each. Then it plants two mutants that must **survive**: a behaviour-preserving rewrite of the omission test, and removal of the non-object body guard that the source documents as defence in depth rather than load-bearing. The first separates a real kill from a suite that is red for unrelated reasons; the second keeps that source comment honest, because if the guard ever becomes observable the control starts failing. The gate restores `src/telemetry.ts` on every exit path and refuses to report success unless the file hashes identical to how it started.

**Stage 2 - real stack.** Drives the public `registerAxonFlowGovernance` entry point through registration and the first heartbeat against a local receiver, and asserts the captured ping carries `license_tier` relayed verbatim from the `/health` `tier` key, with a `deployment_mode` that differs from it.

## Run

```bash
./runtime-e2e/license_tier_telemetry/test.sh
```
