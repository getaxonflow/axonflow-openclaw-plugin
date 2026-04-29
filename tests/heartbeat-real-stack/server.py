#!/usr/bin/env python3
"""
Localhost fake AxonFlow agent + checkpoint for real-stack E2E.

Two endpoints in one process so the harness can drive the plugin through
its full first-run flow without hitting any external service:

  POST /api/v1/register      → mint a fake cs_<uuid> tenant, 201
  GET  /health               → return a synthetic platform_version
  POST /api/v1/mcp-server    → stub MCP that allows everything
  POST /v1/ping              → record telemetry payloads to disk

Counter file at <work>/_counter records exactly how many telemetry pings
the harness has captured. Cold-run expects +1; warm-run expects +0.

Run:
    python3 server.py <port> <work_dir>

Output (stdout):
    server ready
"""

import sys

# Emit an early heartbeat so the harness diagnostic catches Python
# launching even if a later import or socket bind fails.
print(f"server starting (python {sys.version_info.major}.{sys.version_info.minor})", flush=True)

import http.server
import json
import os
import threading
import time
import uuid

print("server modules imported", flush=True)


def make_handler(work_dir):
    counter_path = os.path.join(work_dir, "_counter")
    pings_path = os.path.join(work_dir, "_pings.jsonl")
    register_path = os.path.join(work_dir, "_registrations.jsonl")

    # Initialize counter so the harness can read it even before any ping arrives.
    if not os.path.exists(counter_path):
        with open(counter_path, "w") as fh:
            fh.write("0")

    class Handler(http.server.BaseHTTPRequestHandler):
        # Suppress request log to keep harness output clean.
        def log_message(self, *_args, **_kwargs):
            return

        def _read_body(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length == 0:
                return b""
            return self.rfile.read(length)

        def _json(self, status, body):
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if self.path == "/health":
                self._json(200, {"status": "healthy", "version": "7.5.0-fake"})
                return
            self._json(404, {"error": "not found"})

        def do_POST(self):
            body = self._read_body()
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {"_raw": body.decode("utf-8", errors="replace")}

            if self.path == "/api/v1/register":
                tenant_id = f"cs_{uuid.uuid4()}"
                secret = uuid.uuid4().hex
                response = {
                    "tenant_id": tenant_id,
                    "secret": secret,
                    "expires_at": "2099-01-01T00:00:00Z",
                    "endpoint": f"http://127.0.0.1:{self.server.server_port}",
                    "note": "fake-stack",
                }
                with open(register_path, "a") as fh:
                    fh.write(json.dumps({"label": payload.get("label"), "tenant_id": tenant_id}) + "\n")
                self._json(201, response)
                return

            if self.path == "/v1/ping":
                with open(pings_path, "a") as fh:
                    fh.write(json.dumps(payload) + "\n")
                # Bump the counter atomically so concurrent pings don't race.
                with open(counter_path, "r+") as fh:
                    n = int(fh.read().strip() or "0") + 1
                    fh.seek(0)
                    fh.write(str(n))
                    fh.truncate()
                self._json(200, {"ok": True})
                return

            if self.path == "/api/v1/mcp-server":
                # MCP allow-all stub. Returns a JSON-RPC envelope so
                # pre-tool-check.sh's parsing succeeds.
                response = {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps({
                                    "allowed": True,
                                    "policies_evaluated": 0,
                                }),
                            }
                        ]
                    },
                }
                self._json(200, response)
                return

            self._json(404, {"error": "not found", "path": self.path})

    return Handler


def main():
    if len(sys.argv) != 3:
        print("usage: server.py <port> <work_dir>", file=sys.stderr)
        sys.exit(2)
    port = int(sys.argv[1])
    work_dir = sys.argv[2]
    os.makedirs(work_dir, exist_ok=True)

    handler = make_handler(work_dir)
    server = http.server.HTTPServer(("127.0.0.1", port), handler)
    server.allow_reuse_address = True

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # Signal readiness two ways: a sentinel file (atomic + race-free) and
    # stdout (for human-readable harness output). Some macOS GH runner
    # configurations buffer Python stdout when redirected to a file even
    # with flush=True, so the file-based signal is the authoritative
    # readiness check.
    ready_file = os.path.join(work_dir, "_server_ready")
    with open(ready_file, "w") as fh:
        fh.write("ready\n")
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            pass
    try:
        sys.stdout.write("server ready\n")
        sys.stdout.flush()
    except Exception:
        pass

    # Persist for the lifetime of the parent (harness manages teardown).
    while True:
        try:
            time.sleep(3600)
        except KeyboardInterrupt:
            break

    server.shutdown()


if __name__ == "__main__":
    main()
