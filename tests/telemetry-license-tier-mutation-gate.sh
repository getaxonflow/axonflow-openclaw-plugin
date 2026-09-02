#!/usr/bin/env bash
# Mutation gate for the license_tier tests in tests/telemetry.test.ts (#3619).
#
# A green suite proves nothing on its own. This gate plants one defect at a
# time in src/telemetry.ts, reruns the suite, and requires it to FAIL — once
# per property those tests claim to protect.
#
# It also plants two mutants that must SURVIVE:
#
#   * an equivalent rewrite of the omission test, which changes no behaviour.
#     A gate that reports every mutant as killed cannot tell a real kill from
#     a suite that is red for unrelated reasons.
#   * removal of the non-object body guard, which is documented in the source
#     as defence in depth rather than load-bearing. Encoding it here keeps
#     that claim honest: if the guard ever becomes observable, this control
#     starts failing and the comment is what needs updating.
#
# Two traps this is built to avoid:
#
#   * A textual patcher rewriting the FIRST match when the intended target is
#     the second. Every substitution asserts it matched EXACTLY ONCE and that
#     the file actually changed.
#   * A mutant that does not change the OUTCOME. A neutered guard that leaves
#     behaviour identical is not a mutant, and its survival says nothing.
#
# src/telemetry.ts is mutated IN PLACE because jest compiles from src/. It is
# restored from a backup held outside the tree on every exit path, and the gate
# refuses to report success unless the file hashes identical to how it started.
#
# Exit: 0 all mutants behaved as required · 1 otherwise.

set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HARNESS_DIR/.." && pwd)"
TARGET="$PLUGIN_DIR/src/telemetry.ts"
SUITE="tests/telemetry.test.ts"

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not on PATH"
  exit 0
fi
if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  echo "SKIP: node_modules absent — run 'npm ci' first"
  exit 0
fi

BACKUP=$(mktemp)
cp "$TARGET" "$BACKUP"
ORIGINAL_HASH=$(shasum -a 256 "$TARGET" | awk '{print $1}')

restore() { cp "$BACKUP" "$TARGET"; }
cleanup() { restore; rm -f "$BACKUP"; }
trap cleanup EXIT

PASSED=0
FAILED=0
pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL: $1" >&2; FAILED=$((FAILED + 1)); }

apply_mutation() {
  OLD="$1" NEW="$2" SRC="$BACKUP" DST="$TARGET" node -e '
const fs = require("fs");
const old = process.env.OLD, nw = process.env.NEW;
const src = fs.readFileSync(process.env.SRC, "utf8");
const n = src.split(old).length - 1;
if (n !== 1) { console.error(`AMBIGUOUS: pattern matched ${n} times, expected exactly 1`); process.exit(2); }
const out = src.replace(old, nw);
if (out === src) { console.error("NO-OP: substitution changed nothing"); process.exit(3); }
fs.writeFileSync(process.env.DST, out);
'
}

# expect_mutant <killed|survives> <label> <old> <new>
expect_mutant() {
  local want="$1" label="$2" old="$3" new="$4"

  restore
  if ! apply_mutation "$old" "$new"; then
    fail "[$label] could not plant the mutant (pattern absent, ambiguous, or no-op)"
    restore
    return
  fi

  local out rc
  out=$(cd "$PLUGIN_DIR" && npx jest "$SUITE" 2>&1)
  rc=$?
  restore

  if [ "$want" = "killed" ]; then
    if [ "$rc" -ne 0 ]; then
      pass "[$label] mutant killed ($(printf '%s' "$out" | grep -cE '^\s+✕') test(s) went red)"
    else
      fail "[$label] MUTANT SURVIVED — the suite does not actually protect this property"
    fi
  else
    if [ "$rc" -eq 0 ]; then
      pass "[$label] control survived, as required"
    else
      fail "[$label] control was KILLED — this mutant is behaviour-preserving, so the suite is red for the wrong reason"
      printf '%s\n' "$out" | grep -E '^\s+✕' >&2
    fi
  fi
}

echo "--- Mutation gate: license_tier properties in $SUITE ---"

# M1 — the field is never attached to the payload.
expect_mutant killed "field never sent" \
  '...(platformInfo.licenseTier ? { license_tier: platformInfo.licenseTier } : {}),' \
  ''

# M2 — omission collapsed into a literal "unknown". The single most important
# distinction in this change: absent means the plugin did not establish a tier;
# "unknown" means the platform answered and said it did not know.
expect_mutant killed "omission replaced by a literal unknown" \
  '...(platformInfo.licenseTier ? { license_tier: platformInfo.licenseTier } : {}),' \
  'license_tier: platformInfo.licenseTier ?? "unknown",'

# M3 — the string-type check removed, so a numeric / boolean / structured tier
# is coerced onto the wire as though the platform had reported it.
expect_mutant killed "string-type check replaced by coercion" \
  '  const raw = body[key];
  if (typeof raw !== "string" || !raw) return null;
  if (raw.length > MAX_RELAYED_VALUE_LENGTH) return null;
  return raw;' \
  '  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const coerced = String(raw);
  if (coerced.length > MAX_RELAYED_VALUE_LENGTH) return null;
  return coerced;'

# M4 — the non-2xx guard neutered, so an error body is parsed for a tier.
expect_mutant killed "non-2xx guard neutered" \
  'if (!resp.ok) return NO_PLATFORM_INFO;' \
  'if (!resp.ok && false) return NO_PLATFORM_INFO;'

# M5 — the length cap raised out of reach.
expect_mutant killed "length cap raised out of reach" \
  'const MAX_RELAYED_VALUE_LENGTH = 64;' \
  'const MAX_RELAYED_VALUE_LENGTH = 100000;'

# M6 — client-side normalization. The plugin must relay, not interpret.
expect_mutant killed "client-side normalization introduced" \
  '  return raw;' \
  '  return raw.toLowerCase();'

# M7 — a second /health request, which would make this a new data collection
# rather than a new field on an existing probe.
expect_mutant killed "second /health request introduced" \
  '    const resp = await fetch(`${endpoint}/health`, {' \
  '    await fetch(`${endpoint}/health`, { method: "GET" });
    const resp = await fetch(`${endpoint}/health`, {'

# C1 — control. Equivalent rewrite of the emptiness test at the exact site the
# other mutants attack. Identical behaviour for every string, so the suite must
# stay green: that is what shows it tests behaviour rather than source text.
expect_mutant survives "equivalent rewrite of the omission test (control)" \
  '...(platformInfo.licenseTier ? { license_tier: platformInfo.licenseTier } : {}),' \
  '...(platformInfo.licenseTier !== null && platformInfo.licenseTier !== ""
      ? { license_tier: platformInfo.licenseTier }
      : {}),'

# C2 — control, and a claim about the source kept honest. The non-object body
# guard is documented as defence in depth, NOT load-bearing: indexing a null,
# array, string or number body already yields undefined or throws into the
# catch. If this control ever starts being killed, the guard has become
# observable and that comment needs to change.
expect_mutant survives "non-object body guard removed (documented as defence in depth)" \
  '    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NO_PLATFORM_INFO;
    }' \
  '    if (body === null) {
      return NO_PLATFORM_INFO;
    }'

# ---------------------------------------------------------------------------
# The relays added for enterprise#3662, and the two redirect properties.
# ---------------------------------------------------------------------------

expect_mutant killed "edition never sent" \
  '    ...(platformInfo.edition ? { edition: platformInfo.edition } : {}),' \
  ''

expect_mutant killed "platform_deployment_mode never sent" \
  '    ...(platformInfo.platformDeploymentMode
      ? { platform_deployment_mode: platformInfo.platformDeploymentMode }
      : {}),' \
  ''

# THE dangerous one: the platform'"'"'s own mode written over this plugin'"'"'s local
# classification. The wire stays valid and the value looks plausible; what
# breaks is every existing deployment_mode figure. Only a fixture where the two
# DISAGREE can catch it.
expect_mutant killed "platform mode written over the local classification" \
  '    deployment_mode: deploymentMode,' \
  '    deployment_mode: platformInfo.platformDeploymentMode ?? deploymentMode,'

# Redirect following restored, one leg at a time. fetch follows by DEFAULT, so
# removing the option is the real-world regression rather than an exotic one.
expect_mutant killed "redirect following restored on the /health probe" \
  '      // which is the same fail-open path as any other probe failure.
      redirect: "error",' \
  '      redirect: "follow",'

expect_mutant killed "redirect following restored on the checkpoint POST" \
  '      // week (sdk-rust#89). "error" throws instead, and the stamp stays put.
      redirect: "error",' \
  '      redirect: "follow",'

echo ""
echo "--- Source integrity ---"
FINAL_HASH=$(shasum -a 256 "$TARGET" | awk '{print $1}')
if [ "$FINAL_HASH" = "$ORIGINAL_HASH" ]; then
  pass "src/telemetry.ts restored byte-identical"
else
  fail "src/telemetry.ts DIFFERS from its pre-gate state — restore it from git before committing"
fi

echo ""
echo "========================================"
echo " telemetry relay mutation gate (openclaw)"
echo "========================================"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
[ "$FAILED" -eq 0 ]
