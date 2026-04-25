// Tiny AxonFlow agent stub used by the install-smoke harness.
// Not a fixture for real e2e — just enough surface area to prove the
// freshly-tarballed plugin can wire up an AxonFlowClient and exchange
// HTTP traffic in the Plugin Batch 1 response shape.
//
// Endpoints implemented:
//   GET  /health                      → 200 { status: "ok", version: "stub" }
//   POST /api/v1/mcp/check-input      → 401 if Basic auth header is missing
//                                       or doesn't match STUB_EXPECTED_AUTH,
//                                       403 deny when statement contains a
//                                       SQLi marker, 200 allow otherwise.
//
// Auth is enforced when STUB_EXPECTED_AUTH is set. The harness sets this
// to the exact `Basic <base64>` header the AxonFlowClient should be
// emitting; if the client drops or mangles the header, every check-input
// becomes a 401 and the harness's positive/negative assertions fail.
// Without this guard a real install regression that broke Basic auth
// would still pass the smoke against a permissive stub.
//
// X-User-Email is similarly enforced when STUB_EXPECTED_USER_EMAIL is set.
//
// Listens on a port picked by the OS (port 0). Prints `STUB_LISTENING:<port>`
// to stdout once ready so the harness can read the assigned port.

import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT || 0);
const EXPECTED_AUTH = process.env.STUB_EXPECTED_AUTH || '';
const EXPECTED_USER_EMAIL = process.env.STUB_EXPECTED_USER_EMAIL || '';

const server = createServer((req, res) => {
  // Buffer-concat (not string-concat) so multi-byte UTF-8 sequences
  // split across chunks don't decode to U+FFFD replacements.
  const chunks = [];
  req.on('data', (chunk) => {
    chunks.push(chunk);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = req.url || '';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: 'stub' }));
      return;
    }

    if (req.method === 'POST' && url === '/api/v1/mcp/check-input') {
      // Enforce the Basic auth + X-User-Email wiring that real clients
      // depend on. A regression that drops or garbles either header
      // would otherwise sail past the smoke.
      if (EXPECTED_AUTH) {
        const got = req.headers['authorization'];
        if (got !== EXPECTED_AUTH) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'unauthorized',
              detail: 'stub: Authorization header missing or did not match STUB_EXPECTED_AUTH',
            }),
          );
          return;
        }
      }
      if (EXPECTED_USER_EMAIL) {
        const got = req.headers['x-user-email'];
        if (got !== EXPECTED_USER_EMAIL) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'unauthorized',
              detail: 'stub: X-User-Email missing or did not match STUB_EXPECTED_USER_EMAIL',
            }),
          );
          return;
        }
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }
      const stmt = String(parsed.statement || '');
      // Two unambiguous SQLi signals. The bare `--` line-comment
      // marker is intentionally NOT included here — it false-fires
      // on any benign hyphenated identifier or ISO date string.
      const sqli = /\bOR\s+'?1'?\s*=\s*'?1'?\b|;\s*DROP\s+TABLE\b/i.test(stmt);
      if (sqli) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            allowed: false,
            block_reason: 'SQL injection pattern detected (stub)',
            decision_id: 'dec_stub_0001',
            risk_level: 'high',
            policy_matches: [
              {
                policy_id: 'sys_sqli_or_1_eq_1',
                policy_name: 'SQLi: OR 1=1',
                category: 'security',
              },
            ],
            override_available: true,
            policies_evaluated: ['sys_sqli_or_1_eq_1'],
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          allowed: true,
          decision_id: 'dec_stub_0002',
          risk_level: 'low',
          policy_matches: [],
          override_available: false,
          policies_evaluated: [],
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: url }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  process.stdout.write(`STUB_LISTENING:${port}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
