# Contributing to AxonFlow OpenClaw plugin

Thank you for your interest in contributing! Please open an issue or pull request via the [GitHub repository](https://github.com/getaxonflow/axonflow-openclaw-plugin).

## Sign your commits — Developer Certificate of Origin (DCO) is required

All contributions to this repository must be **signed off** under the [Developer Certificate of Origin v1.1](https://developercertificate.org/). The DCO is a per-commit affirmation that you wrote the code (or otherwise have the right to submit it) and are licensing it under the same license as the rest of this repository.

Add the sign-off automatically with `-s` (or `--signoff`) on every commit:

```bash
git commit -s -m "your commit message"
```

This appends a trailer like:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match `git config user.name` / `git config user.email`.

If you forgot `-s` on an existing commit, fix it with one of:

```bash
# most recent commit
git commit --amend --signoff --no-edit

# every commit on the current branch
git rebase --signoff origin/main
```

A DCO check runs automatically on every PR opened in the `getaxonflow` org. **PRs with any unsigned commit will be blocked from merging until the missing sign-offs are added.** No exceptions, including for maintainers.

## Development setup

```bash
npm install
npm run build
npm test
```

## Pull request guidelines

1. Keep PRs focused — one feature or fix per PR.
2. Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
3. Ensure `npm test`, `npm run lint`, and the install-to-use smoke gate are green.
4. New MCP-response fields surfaced from the platform should be threaded through `MCPCheckInputResponse` / `MCPCheckOutputResponse` and rendered in `governance.ts` if user-facing.

## Baseline burndown policy

Several CI gates may carry a baseline file to grandfather pre-existing findings — the gate fails on any *new* finding but tolerates the listed ones. Baselines exist to land the gate without a giant cleanup PR; they are not intended to be permanent.

When your PR touches a baselined area, do one of:

- **Burn it down.** Fix the baselined finding in this PR, remove the entry from the baseline file, and note "burndown: `<entry>`" in the PR description.
- **Justify it.** If the finding can't be fixed in this PR (different scope, blocked on a platform change, etc.), say so in the PR description in one line.

Reviewers will ask the burndown-or-justify question on PRs that touch baselined areas without addressing them.

## Wire-shape contract (Cat C three-bucket framework)

The OpenClaw plugin imports MCP response shapes from the AxonFlow agent. We track three buckets of drift:

1. **Canonical wire-bound types — gate-zero.** `MCPCheckInputResponse`, `MCPCheckOutputResponse`, `DecisionExplanation`. Every property must trace to the agent's OpenAPI spec or be marked `@deprecated`. Drift here fails CI.
2. **Raw / helper types — accept non-zero drift.** Internal config types, helper return shapes, computed views. Drift count for these is allowed to grow with the plugin's API surface.
3. **`@sdkDerived` first-class marker (deferred).** When a property is a plugin-side derivation (not a wire field), mark it with a JSDoc tag the wire-shape gate recognizes. Implementation deferred; convention is documented in the AxonFlow ADR-047 (rigor gates).

## Questions

- Open a GitHub issue
- Email: hello@getaxonflow.com
