# Runtime E2E evidence — status CLI surfaces canonical pricing URL

**Date (UTC):** 2026-05-06 13:18:15
**Branch:** chore/v2.2.0-skill-and-readme-paid-upgrade

## What was tested

Per HARD RULE #0, this PR rewrites STATUS_DEFAULT_UPGRADE_URL — a
customer-facing surface (the URL printed by the bundled status CLI for
free-tier users). The unit-test layer (`tests/status.test.ts`) verifies
the constant + format function, but the rule requires the change be
exercised against the actual CLI dispatch path.

`test.sh` invokes `bin/axonflow-openclaw-status.mjs` (the bin entry
package.json registers under `axonflow-openclaw-status`) twice:

1. Human-readable mode — must contain `https://getaxonflow.com/pricing/`
   and must NOT contain stale `/pro` URLs.
2. `--json` mode — must parse as valid JSON; `.upgrade_url` must equal
   `https://getaxonflow.com/pricing/` byte-for-byte.

Run with `AXONFLOW_CONFIG_DIR` pointed at a temp dir so the test
doesn't depend on (or pollute) the developer's real registration file.

## Result

**PASS** — all three assertions satisfied against the freshly-built
plugin.

See `status_human.txt`, `status_human.err`, and `status_json.json` for
captured output.

## Reproducing

```bash
npm run build
bash runtime-e2e/status-cli-url/test.sh
```

The script writes a fresh evidence dir under
`runtime-e2e/status-cli-url/EVIDENCE/<UTC-timestamp>/`.
