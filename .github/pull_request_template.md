## Is this user-facing?

<!-- Required: choose one. See `runtime-e2e/README.md` for the convention. -->

- [ ] **Yes** — includes a runtime-path test under `runtime-e2e/<feature>/` that exercises this capability through OpenClaw's plugin runtime (`openclaw plugins install` + tool/hook dispatch). Importing the plugin's TypeScript classes directly does NOT count.
- [ ] **No** — internal-only change (build, ci, deps, docs, refactor, lint, test infra). Reason (must name a specific downstream consumer; "future PRs" or "wire later" is NOT acceptable): ___________

If user-facing, the wiring PR for OpenClaw must land with this PR (or be linked and merged in the same release window). No "wire it later."

> **If a user cannot reach the feature from their runtime, we did not ship a feature, we shipped a library.**

See [`runtime-e2e/README.md`](../runtime-e2e/README.md) for the convention. The cross-plugin coverage matrix lives at `axonflow-internal-docs/engineering/FEATURE_RUNTIME_COVERAGE.md` (private; engineering team only).

---

## Description

<!-- What changed and why -->

## Type of change

- [ ] feat: new capability exposed to users
- [ ] fix: bug fix
- [ ] docs: documentation only
- [ ] chore / build / ci / refactor / test
- [ ] breaking change (describe migration)

## How to test

<!-- Concrete steps to validate locally -->

1.

## Checklist

- [ ] CHANGELOG entry added under `[Unreleased]`
- [ ] Conventional Commits format on commits
- [ ] DCO sign-off (`-s` flag) on every commit
- [ ] All CI green

## Related

Closes #
Relates to #
