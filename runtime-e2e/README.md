# Runtime End-to-End Tests — OpenClaw plugin

Tests in this directory MUST invoke the plugin through OpenClaw's plugin runtime — installation via `openclaw plugins install`, plugin load, and tool/hook dispatch through the OpenClaw host. Importing the plugin's TypeScript modules directly (`import { AxonFlowClient } from '../src/...'`) is not a runtime test — that's a unit/integration test, which lives under `tests/`.

If OpenClaw can't expose your feature yet, the feature isn't ready to ship.

## Why this directory exists

A May 3, 2026 audit found multiple AxonFlow capabilities (audit search, decision explain, override CRUD) where the platform endpoint and SDK method existed for months but no plugin tool/hook ever wired them up. Users running OpenClaw with the AxonFlow plugin could not reach the capability. The fix: every user-facing AxonFlow feature exposed via this plugin must have a test in this directory that invokes through OpenClaw's runtime.

The single rule:

> **If a user cannot reach the feature from their runtime, we did not ship a feature, we shipped a library.**

## What "runtime" means here

The runtime is the OpenClaw plugin host. A test must:

- Install the plugin through `openclaw plugins install` (from the local tarball or the published ClawHub artifact) — not from a relative source path.
- Load it inside a real OpenClaw session.
- Trigger the capability through OpenClaw's dispatch — `api.registerTool` for tools or `api.on(...)` for hooks — rather than calling the plugin's TypeScript class directly.

If a test imports from `src/` and calls the AxonFlow client class, it is a unit test or an integration test against the AxonFlow stack. That belongs under `tests/` or `tests/integration/`, not here.

## Layout

```
runtime-e2e/
  README.md                    # this file
  <feature-name>/              # one folder per feature
    test.sh                    # bash runner; invokes through openclaw
    README.md                  # 5 lines: prereqs, what it asserts, how to run
```

## Running

Each test folder has its own README with prereqs and run instructions. Most tests assume:

- An AxonFlow community-saas-style stack is reachable (default endpoint or via env var).
- A working `openclaw` CLI is installed and on `$PATH`.
- The plugin is built locally (`npm run build`) so the tarball is available for `openclaw plugins install`.

## Adding a test

1. Confirm you can invoke the feature through `openclaw` — install the plugin, then trigger via tool/hook dispatch. If you can't, the answer is to fix the plugin's tool registration (in `src/index.ts`), not to write an SDK-import test.
2. Create the folder, write `test.sh` and `README.md`.
3. Update `axonflow-internal-docs/engineering/FEATURE_RUNTIME_COVERAGE.md` (private; engineering team only) to mark the new green cell under the OpenClaw column.
4. Reference the test in the PR that wires the feature.
