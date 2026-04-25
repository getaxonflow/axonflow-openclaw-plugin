// Tiny AxonFlow agent stub used by the install-smoke harness.
// Not a fixture for real e2e — just enough surface area to prove the
// freshly-tarballed plugin can wire up an AxonFlowClient and exchange
// HTTP traffic in the Plugin Batch 1 response shape.
//
// Endpoints implemented:
//   GET  /health                      → 200 { status: "ok", version: "stub" }
//   POST /api/v1/mcp/check-input      → 403 deny when statement contains a
//                                       SQLi marker, 200 allow otherwise.
//
// Listens on a port picked by the OS (port 0). Prints `STUB_LISTENING:<port>`
// to stdout once ready so the harness can read the assigned port.

import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT || 0);

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = req.url || '';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: 'stub' }));
      return;
    }

    if (req.method === 'POST' && url === '/api/v1/mcp/check-input') {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }
      const stmt = String(parsed.statement || '');
      const sqli = /OR\s+1=1|--|;\s*DROP\s+TABLE/i.test(stmt);
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
