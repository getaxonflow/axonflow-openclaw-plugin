#!/usr/bin/env bash
# Runtime proof for the ADR-065 PEP capability handshake
# (getaxonflow/axonflow-enterprise#3763).
#
# It drives the plugin's REAL built client over a REAL socket and asserts on the
# headers a server actually received. The unit tests assert what the client
# hands to a mocked fetch; that cannot show the header surviving the real
# transport, nor that the two enforcement points stay distinct across two
# requests on one client - which is the property the whole design turns on.
#
# Stage 1 (always): the real client, the real transport, a real listener.
# Stage 2 (when an agent is reachable): the platform itself decides whether the
# bytes this plugin builds are a valid declaration.
#
# Run:
#   ./runtime-e2e/pep-capability-handshake/test.sh
#   AXONFLOW_ENDPOINT=http://localhost:8080 ./runtime-e2e/pep-capability-handshake/test.sh

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== stage 1: the real client over a real socket ==="
if [ ! -d node_modules ]; then
  echo "  SKIP: dependencies not installed (run npm ci)"
else
  OUT=$(node --input-type=module -e '
import http from "node:http";
import { AxonFlowClient } from "./dist/axonflow-client.js";

const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, hs: req.headers["x-axonflow-pep-handshake"] ?? null });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ allowed: true, policies_evaluated: 1 }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const client = new AxonFlowClient({
  endpoint: `http://127.0.0.1:${port}`,
  clientId: "runtime-e2e",
  clientSecret: "runtime-e2e-secret",
  mode: "self-hosted",
  pepAudience: "axonflow-decision-proof",
});
await client.mcpCheckInput("openclaw.web_fetch", "{}");
await client.mcpCheckOutput("openclaw.send_message", "hi");

const bare = new AxonFlowClient({
  endpoint: `http://127.0.0.1:${port}`,
  clientId: "runtime-e2e",
  clientSecret: "runtime-e2e-secret",
  mode: "self-hosted",
});
await bare.mcpCheckInput("openclaw.web_fetch", "{}");

server.close();
console.log(JSON.stringify(seen));
' 2>/dev/null | tail -1)

  if [ -z "$OUT" ]; then
    echo "  SKIP: the built client could not be driven (run npm run build)"
  else
    REQ=$(node -e "const s=JSON.parse(process.argv[1]);console.log(s[0]?.hs??'')" "$OUT")
    RES=$(node -e "const s=JSON.parse(process.argv[1]);console.log(s[1]?.hs??'')" "$OUT")
    BARE=$(node -e "const s=JSON.parse(process.argv[1]);console.log(s[2]?.hs===null?'ABSENT':(s[2]?.hs??''))" "$OUT")

    [ -n "$REQ" ] && pass "the request path presented a declaration on the wire" \
      || fail "check-input carried no handshake"
    [ -n "$RES" ] && pass "the response path presented a declaration on the wire" \
      || fail "check-output carried no handshake"
    # The property the design turns on: two enforcement points, two documents.
    # Observable only across two requests on one client.
    [ "$REQ" != "$RES" ] && pass "the two enforcement points presented DIFFERENT declarations" \
      || fail "both paths presented the SAME document; one path is being credited with the other's capability"
    # ABSENT, not empty: a present-but-empty value is malformed to the platform
    # and refuses the request, which an absent header does not.
    [ "$BARE" = "ABSENT" ] && pass "an unconfigured client sent NO handshake header at all" \
      || fail "an unconfigured client sent '$BARE'; a present-but-empty header would 400 every governed call"
  fi
fi

echo
echo "=== stage 2: a real agent decides ==="
ENDPOINT="${AXONFLOW_ENDPOINT:-}"
if [ -z "$ENDPOINT" ] || ! curl -sf --max-time 5 "${ENDPOINT}/health" >/dev/null 2>&1; then
  echo "  SKIP: no reachable agent (set AXONFLOW_ENDPOINT to run this stage)"
else
  HS=$(node -e '
const { buildPepHandshakes } = require("./dist/pep-handshake.js");
process.stdout.write(buildPepHandshakes("axonflow-decision-proof").request);' 2>/dev/null)
  AUTH=(); [ -n "${AXONFLOW_AUTH:-}" ] && AUTH=(-H "Authorization: Basic ${AXONFLOW_AUTH}")
  BODY='{"connector_type":"postgres","statement":"select 1","operation":"execute"}'
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
    "${ENDPOINT}/api/v1/mcp/check-input" -H 'Content-Type: application/json' \
    "${AUTH[@]}" -H "X-Axonflow-PEP-Handshake: ${HS}" -d "$BODY")
  [ "$CODE" != "400" ] && pass "a real agent ACCEPTED the declaration this plugin builds (HTTP ${CODE})" \
    || fail "a real agent refused this plugin's declaration as malformed; the encoding disagrees with the platform"

  BAD=$(curl -s --max-time 20 -X POST "${ENDPOINT}/api/v1/mcp/check-input" \
    -H 'Content-Type: application/json' "${AUTH[@]}" \
    -H "X-Axonflow-PEP-Handshake: !!!not-base64!!!" -d "$BODY")
  grep -q "X-Axonflow-PEP-Handshake" <<<"$BAD" \
    && pass "the same agent REFUSES a malformed declaration and names the header" \
    || fail "the agent did not refuse a malformed declaration, so the assertion above may be vacuous"
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
