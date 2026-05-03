## Is this user-facing?

<!-- Required: choose one. Methodology rule per axonflow-business-docs/engineering/E2E_EXAMPLES_TESTING_WORKFLOW.md (Policy section). -->

- [ ] **Yes** — includes a runtime-path test under `runtime-e2e/<feature>/` that exercises this capability through OpenClaw's plugin runtime (`openclaw plugins install` + tool/hook dispatch). Importing the plugin's TypeScript classes directly does NOT count.
- [ ] **No** — internal-only change (build, ci, deps, docs, refactor, lint, test infra). Reason (must name a specific downstream consumer; "future PRs" or "wire later" is NOT acceptable): ___________

If user-facing, the wiring PR for OpenClaw must land with this PR (or be linked and merged in the same release window). No "wire it later."

> **If a user cannot reach the feature from their runtime, we did not ship a feature, we shipped a library.**

See `axonflow-business-docs/engineering/FEATURE_RUNTIME_COVERAGE.md` for where each AxonFlow capability is wired across the 4 plugins + portal.

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
