# Manual ClawHub skill publication: 2.6.0

This updates the separately published `@axonflow/governance-policies` skill. It does **not** publish the `@axonflow/openclaw` code plugin to npm or ClawHub.

## Reviewed bundle

- Source folder: `clawhub/2.6.0`
- Uploaded file: `clawhub/2.6.0/SKILL.md`
- SHA-256: `0c5d8b6b70c0f3c1f13a4069217c1343e8689f6b2bd6d77bbcd569cdcda3c090`
- ClawHub 0.23.3 dry-run fingerprint: `e16c83a9039865379b74b0ae5d72faa66079ce1a832f88ac1c50cc9c852a3d59`
- Live version before this update: `2.5.0`

## Before publication

1. Merge the reviewed source PR.
2. Check out the exact merged `main` commit and set `MERGED_SHA` to its full 40-character SHA.
3. Re-run the SHA-256 check and require the value above.
4. Run the dry-run command below. Require `"status":"would-publish"`, version `2.6.0`, `fileCount: 1`, and the fingerprint above.

```bash
shasum -a 256 clawhub/2.6.0/SKILL.md

clawhub skill publish clawhub/2.6.0 \
  --owner axonflow \
  --slug governance-policies \
  --name "AxonFlow Governance Policies" \
  --version 2.6.0 \
  --changelog 'Replace obsolete one-time Plugin Pro with live $9.99/month Hosted Starter purchase and OpenClaw device linking; bump plugin floor to 2.10.4.' \
  --tags candidate \
  --topics "Policies,Agent Security,Approvals,Audit,Compliance" \
  --source-repo getaxonflow/axonflow-openclaw-plugin \
  --source-commit "$MERGED_SHA" \
  --source-ref refs/heads/main \
  --source-path clawhub/2.6.0 \
  --dry-run \
  --json
```

The `candidate` tag is intentional. Do not assign `latest` during admission: the
official stored ClawHub security scan exists only after upload.

## Publish candidate manually

Publication is an explicit operator action. After reviewing the dry-run, repeat the same command without `--dry-run`.

Do not run `.github/workflows/publish.yml`, create a package tag, or publish npm/ClawHub code-plugin artifacts for this skill-only update.

## Verify the stored scan before promotion

```bash
clawhub inspect @axonflow/governance-policies --json
clawhub scan --slug governance-policies --version 2.6.0 --json
clawhub scan download governance-policies --version 2.6.0 --output /private/tmp/governance-policies-2.6.0-scan.zip
```

Require:

- the `candidate` tag points to `2.6.0` while the `latest` tag still points to the previously approved version;
- the stored skill description contains the Hosted Starter purchase and installed-link steps;
- the stored scan reaches a completed, clean verdict and its downloaded report is reviewed before promotion or announcement;
- no code-plugin package version, npm dist-tag, or ClawHub package version changed.

If the scan is missing, incomplete, non-clean, or cannot be independently
reviewed, stop. Do not move `latest`, do not announce the candidate, and retain
the report and exact source SHA for investigation. ClawHub CLI 0.23.3 has no
hide, delete, or withdraw command; use the authenticated owner dashboard or
ClawHub support to hide or withdraw version 2.6.0 before preparing a corrected
version. Never overwrite or promote a flagged candidate.

## Promote only after a clean verdict

After all requirements above pass, promote the already scanned immutable
version and verify the tag movement:

```bash
clawhub skill tag @axonflow/governance-policies 2.6.0 --tag latest --yes
clawhub inspect @axonflow/governance-policies --json
```

Require the `latest` tag to point to `2.6.0` and re-check that the stored
version and scan evidence are unchanged. Only then announce the update.

ClawHub 0.23.3 no longer supports scanning a local skill folder. Its official security scan is available only after a version is uploaded, so the pre-publication gates are the one-file dry-run, content tests, link checks, and exact checksums above.
