# pep-capability-handshake

Prereqs: `npm ci && npm run build`. Stage 2 additionally needs a reachable agent (`AXONFLOW_ENDPOINT`, optional `AXONFLOW_AUTH`).
Asserts: the real built client presents the ADR-065 declaration on the wire, one document per enforcement point and none when unconfigured (stage 1); the real client and the real `before_tool_call` handler substitute the platform's engine-masked statement for the tool's parameters, block when the redactor did not report running, and declare `field_redact@1` on that same request path (stage 1b); a real agent accepts the declaration and refuses a malformed one (stage 2).
Run: `./runtime-e2e/pep-capability-handshake/test.sh`
