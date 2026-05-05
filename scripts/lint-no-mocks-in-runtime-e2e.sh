#!/usr/bin/env bash
# lint-no-mocks-in-runtime-e2e.sh
#
# Per HARD RULE #0 in CLAUDE.md: runtime-e2e/ tests MUST hit a real endpoint
# (real plugin in real host CLI; real SDK with real fetch against a real
# running agent). Mocks, stubs, simulators, capture-stub harnesses do NOT
# count as runtime proof.
#
# This script greps runtime-e2e/ for forbidden mock-pattern strings and
# fails the build if any are found. It runs in CI as part of the
# definition-of-done.yml gate.
#
# To bypass for a specific file (rare, must justify in PR):
#   add a line `# allow-mocks-here: <reason>` near the offending line and
#   the lint will skip that file. Reviewers should challenge any usage.

set -uo pipefail

SCAN_DIR="${1:-runtime-e2e}"

if [ ! -d "$SCAN_DIR" ]; then
  echo "lint-no-mocks: $SCAN_DIR not present, nothing to scan."
  exit 0
fi

# Forbidden patterns. Each one represents a way to fake a runtime response.
# Add to this list as new mock libraries arrive in the codebase.
PATTERNS=(
  'mockFetch'                    # jest fetch mock
  'jest\.mock'                   # jest module mock
  'jest\.fn'                     # jest stub
  'sinon\.stub'                  # sinon test double
  'unittest\.mock'               # python stdlib mock
  'MagicMock'                    # python mock class
  'httpx_mock\.add_response'     # python httpx mock
  'wiremock'                     # java/jvm wiremock
  'WireMockServer'               # wiremock builder
  'stubFor'                      # wiremock stub
  'httptest\.NewServer'          # go httptest stub server
  'capture-stub\.py'             # local capture harness
  'fixture-server'               # generic fixture server
  'msw\.setupServer'             # jsdom mock service worker
  'nock\.'                       # nock http stubs (node)
)

EXIT=0
COUNT=0

# Build a regex from PATTERNS; escape literal dots already in the pattern source
REGEX=$(IFS='|'; echo "${PATTERNS[*]}")

# Use plain grep -r so we catch untracked files too (CI sees tracked PR
# content, but local dev/pre-commit may run against new files not yet added).
matches=$(grep -rnE "$REGEX" "$SCAN_DIR" 2>/dev/null || true)

if [ -z "$matches" ]; then
  echo "lint-no-mocks: $SCAN_DIR is clean (no forbidden mock patterns found)."
  exit 0
fi

# Filter out lines explicitly allowed via the inline marker.
while IFS= read -r line; do
  file=$(echo "$line" | cut -d: -f1)
  if [ -n "$file" ] && grep -q "allow-mocks-here:" "$file" 2>/dev/null; then
    continue
  fi
  echo "  $line"
  COUNT=$((COUNT + 1))
  EXIT=1
done <<< "$matches"

if [ "$EXIT" -ne 0 ]; then
  echo ""
  echo "lint-no-mocks: $COUNT forbidden mock-pattern hit(s) in $SCAN_DIR." >&2
  echo "" >&2
  echo "Per CLAUDE.md HARD RULE #0, runtime-e2e/ tests MUST hit a real endpoint." >&2
  echo "Mocks, stubs, fixture-servers, and capture harnesses do NOT count as" >&2
  echo "runtime proof. The runtime-e2e/ test for a feature must invoke the" >&2
  echo "feature through its actual user-facing surface (host CLI tool/skill," >&2
  echo "real SDK fetch to a running agent, etc.)." >&2
  echo "" >&2
  echo "If a specific test legitimately needs a stub (rare — usually means" >&2
  echo "it's not actually a runtime test and belongs elsewhere), add a" >&2
  echo "  # allow-mocks-here: <reason>" >&2
  echo "comment on the line and a reviewer must explicitly approve it." >&2
fi

exit "$EXIT"
