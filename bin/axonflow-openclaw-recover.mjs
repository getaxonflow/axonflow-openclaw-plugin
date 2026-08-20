#!/usr/bin/env node
/**
 * AxonFlow Community-SaaS credential recovery CLI.
 *
 * Usage (after `npm install -g @axonflow/openclaw` or `npx @axonflow/openclaw-recover`):
 *
 *     axonflow-openclaw-recover <email>
 *     # ↳ posts {email} to /api/v1/recover and prompts you to paste the
 *     #   magic-link token (or the full magic-link URL from the email)
 *     #   on stdin. Verifies the token, persists the new credentials at
 *     #   $AXONFLOW_CONFIG_DIR/try-registration.json (mode 0o600), and
 *     #   tells you where the file landed.
 *
 * Non-interactive (for runtime tests / scripts):
 *
 *     # request only:
 *     axonflow-openclaw-recover <email>
 *
 *     # verify only (skip the request step):
 *     axonflow-openclaw-recover --verify <token-or-magic-link-url>
 *
 *     # request + verify in one shot, reading the token from a file:
 *     axonflow-openclaw-recover <email> --token-file /path/to/file
 *
 * Environment variables:
 *
 *     AXONFLOW_ENDPOINT          — agent endpoint to talk to.
 *                                  Default: https://try.getaxonflow.com
 *     AXONFLOW_CONFIG_DIR        — where to persist try-registration.json.
 *                                  Default: per-OS convention (see cache-dir.ts)
 *     AXONFLOW_RECOVERY_TIMEOUT_MS  — per-HTTP timeout. Default: 10000
 *
 * Exit codes:
 *     0 — success
 *     1 — usage error (missing email, bad flag combo)
 *     2 — request step failed
 *     3 — verify step failed
 *     4 — persist step failed (verified token, but couldn't write the
 *         credential file — non-sensitive fields printed to stdout;
 *         secret is NOT printed, re-run to retry persistence)
 */

import * as readline from "node:readline";
import {
  requestRecovery,
  verifyRecovery,
  extractRecoveryToken,
  persistRecoveredCredentials,
  RECOVERY_DEFAULT_ENDPOINT,
} from "../dist/recover.js";
import { stripControlCharacters } from "../dist/sanitize-text.js";

/**
 * #171 class: every string below that came out of a RESPONSE (the verify
 * result's endpoint/email/note fields, the request step's server message,
 * and error messages that embed the response body's own `error` text) is
 * remote-influenced and lands on the operator's terminal. Trim/interpolation
 * alone leaves ESC/BEL intact, which is a terminal-spoofing surface. Strip
 * control characters at render, same as the plugin's other render sinks.
 * The stdout JSON paths need no equivalent: JSON.stringify escapes control
 * characters.
 */
function clean(value) {
  return stripControlCharacters(String(value ?? ""));
}

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  axonflow-openclaw-recover <email>\n" +
      "  axonflow-openclaw-recover <email> --token-file <path>\n" +
      "  axonflow-openclaw-recover --verify <token-or-magic-link-url>\n" +
      "\n" +
      "Run with no arguments to see this message.\n",
  );
}

function readLineFromStdin(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    process.exit(1);
  }

  const endpoint = process.env.AXONFLOW_ENDPOINT || RECOVERY_DEFAULT_ENDPOINT;
  const timeoutMs = Number(process.env.AXONFLOW_RECOVERY_TIMEOUT_MS) || 10_000;

  let mode = "full"; // "full" = request + verify ; "verify" = verify only
  let email = "";
  let tokenInput = "";
  let tokenFile = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verify") {
      mode = "verify";
      tokenInput = argv[i + 1] || "";
      i++;
    } else if (a === "--token-file") {
      tokenFile = argv[i + 1] || "";
      i++;
    } else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else if (a.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      usage();
      process.exit(1);
    } else if (!email) {
      email = a;
    } else {
      process.stderr.write(`Unexpected positional argument: ${a}\n`);
      usage();
      process.exit(1);
    }
  }

  // Mode 1: --verify <token> path. No email required, no request step.
  if (mode === "verify") {
    if (!tokenInput) {
      process.stderr.write("--verify requires a token (or magic-link URL) argument.\n");
      process.exit(1);
    }
    let token;
    try {
      token = extractRecoveryToken(tokenInput);
    } catch (err) {
      process.stderr.write(`Failed to parse token: ${err.message}\n`);
      process.exit(1);
    }
    await runVerify(token, endpoint, timeoutMs);
    return;
  }

  // Mode 2: full path. Email required.
  if (!email) {
    process.stderr.write("Email argument is required.\n");
    usage();
    process.exit(1);
  }

  process.stderr.write(`\n→ Requesting recovery for: ${email}\n`);
  process.stderr.write(`  Endpoint: ${endpoint}\n\n`);

  let req;
  try {
    req = await requestRecovery(email, { endpoint, timeoutMs });
  } catch (err) {
    process.stderr.write(`✗ Recovery request failed: ${clean(err.message)}\n`);
    process.exit(2);
  }
  process.stderr.write(`✓ Request accepted (HTTP ${req.status})\n`);
  process.stderr.write(`  Server says: ${clean(req.message)}\n\n`);
  process.stderr.write(
    "  Check your inbox for a magic link (subject usually mentions AxonFlow).\n" +
      "  When you have it, paste the FULL link OR just the token portion\n" +
      "  (the value of `?token=…`) below.\n\n",
  );

  // Token source: file flag, or interactive stdin.
  let tokenRaw = "";
  if (tokenFile) {
    const fs = await import("node:fs");
    try {
      tokenRaw = fs.readFileSync(tokenFile, "utf8").trim();
    } catch (err) {
      process.stderr.write(`✗ Could not read token file ${tokenFile}: ${err.message}\n`);
      process.exit(1);
    }
  } else {
    tokenRaw = (await readLineFromStdin("Paste magic link or token: ")).trim();
  }

  let token;
  try {
    token = extractRecoveryToken(tokenRaw);
  } catch (err) {
    process.stderr.write(`✗ Failed to parse token: ${err.message}\n`);
    process.exit(1);
  }

  await runVerify(token, endpoint, timeoutMs);
}

async function runVerify(token, endpoint, timeoutMs) {
  process.stderr.write(`\n→ Verifying token (length=${token.length}) against ${endpoint}\n`);
  let result;
  try {
    result = await verifyRecovery(token, { endpoint, timeoutMs });
  } catch (err) {
    process.stderr.write(`✗ Verify failed: ${clean(err.message)}\n`);
    process.exit(3);
  }

  process.stderr.write(`✓ Verify succeeded — credentials issued for ${clean(result.email)}\n`);
  process.stderr.write(`  tenant_id:  ${clean(result.tenant_id)}\n`);
  if (result.secret_prefix) {
    process.stderr.write(`  secret:     ${result.secret_prefix}… (full value will be persisted)\n`);
  } else {
    process.stderr.write(`  secret:     ${result.secret.slice(0, 8)}… (full value will be persisted)\n`);
  }
  process.stderr.write(`  endpoint:   ${clean(result.endpoint)}\n`);
  process.stderr.write(`  expires_at: ${clean(result.expires_at)}\n`);
  if (result.note) {
    process.stderr.write(`  note:       ${clean(result.note)}\n`);
  }

  let savedAt;
  try {
    savedAt = persistRecoveredCredentials(result);
  } catch (err) {
    process.stderr.write(`\n✗ Could not persist credentials: ${err.message}\n`);
    process.stderr.write(
      "\nCredentials are valid; save them manually and add to your plugin config:\n",
    );
    const { secret, ...safe } = result;
    process.stdout.write(JSON.stringify(safe, null, 2) + "\n");
    process.stderr.write(
      "\n  The secret was NOT printed to stdout. Re-run the recovery flow\n" +
        "  to persist credentials to disk automatically.\n",
    );
    process.exit(4);
  }
  process.stderr.write(`\n✓ Credentials persisted to:\n  ${savedAt}\n`);
  process.stderr.write(
    "\n  Reload your OpenClaw runtime — the plugin will pick up the recovered\n" +
      "  registration on next init. No further config change needed.\n",
  );
  const { secret, ...safe } = result;
  process.stdout.write(JSON.stringify({ saved_at: savedAt, ...safe }) + "\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`\nUnexpected error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
