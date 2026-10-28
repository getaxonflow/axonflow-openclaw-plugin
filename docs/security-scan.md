# OpenClaw pre-publish security gate

Run the complete local gate before publishing:

```bash
npm ci
npm install -g openclaw@latest
OPENCLAW_BIN="$(npm prefix -g)/bin/openclaw" npm run scan
```

The gate builds and packs the plugin, checks the published file set for bait
shapes, proves a hostile credential-exfiltration fixture is blocked, and then
installs the exact tarball through the latest OpenClaw release.

`OPENCLAW_BIN` is explicit because npm prepends the repository's local
`node_modules/.bin` directory while running scripts. Without the override, a
peer dependency can shadow the freshly installed global CLI.

OpenClaw no longer performs built-in dangerous-code blocking for local plugin
installs. The release gate therefore configures the supported
`security.installPolicy` interface with
`scripts/openclaw-install-policy.mjs`. The policy fails closed on malformed
requests, scanner errors, unsafe symlinks, oversized source trees, and source
files that co-locate credential access with outbound network or process
execution.

`--force` acknowledges that the archive is outside ClawHub trust metadata. It
cannot override an install-policy block or policy execution failure.

## Expected result

The log must include both of these lines:

```text
scan-tarball: Hostile OpenClaw install control: blocked as expected
scan-tarball: Scan PASSED — install policy allowed the exact packed artifact.
```

A pass without the hostile-control line is not acceptable release evidence.
Keep `scripts/openclaw-install-policy.mjs` and the scan workflow in the same
review and rerun the full gate after either changes.

## Failure handling

- Exit 1 means the policy found a dangerous pattern. Keep the release blocked
  and separate credential acquisition from the outbound or process-execution
  module.
- Exit 2 means the gate could not establish trustworthy evidence. Fix the
  toolchain, policy configuration, or package build, then rerun it.
- Do not pin an older OpenClaw version to make the gate pass. Compatibility
  with the latest install-policy protocol is part of the release check.
