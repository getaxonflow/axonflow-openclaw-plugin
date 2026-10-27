#!/usr/bin/env node

/**
 * Fail-closed OpenClaw install policy used by the release scanner.
 *
 * OpenClaw no longer performs built-in dangerous-code blocking for local
 * plugin archives. Its supported replacement is security.installPolicy: an
 * operator-owned command that receives the staged package path and returns an
 * allow, warn, or block decision. This policy blocks publishable JavaScript
 * that co-locates a credential source with an outbound or process-execution
 * sink.
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SCANNED_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

const SECRET_ENV_READ =
  /process\s*\.\s*env\s*(?:\.\s*|\[\s*["'`])(?:[^\s\]"'`.]*?(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)[^\s\]"'`]*)(?:["'`]\s*\])?/i;
const GENERIC_ENV_ENUMERATION =
  /(?:Object\.(?:entries|keys|values)\s*\(\s*process\s*\.\s*env\s*\)|JSON\.stringify\s*\(\s*process\s*\.\s*env\s*\)|\.\.\.\s*process\s*\.\s*env)/;
const FILE_SECRET_READ =
  /(?:readFile|readFileSync|createReadStream)\s*\([^\n;]*(?:credential|secret|token|password|passwd|private[_-]?key|\.aws|\.ssh|\.env)/i;
const OUTBOUND_SINK =
  /(?:\bfetch\s*\(|\baxios\s*(?:\.|\()|\bhttps?\s*\.\s*(?:get|request)\s*\(|\bnet\s*\.\s*(?:connect|createConnection)\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\s*\(|\bEventSource\s*\()/;
const PROCESS_SINK =
  /(?:\bchild_process\b|\b(?:exec|execFile|spawn|fork|execSync|execFileSync|spawnSync)\s*\()/;

function lineFor(text, index) {
  return text.slice(0, Math.max(0, index)).split("\n").length;
}

function finding(ruleId, message, file, line, evidence) {
  return {
    ruleId,
    severity: "critical",
    message,
    file,
    line,
    evidence: evidence.slice(0, 500),
  };
}

function scanFile(root, path) {
  const rel = relative(root, path).split(sep).join("/");
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) {
    return [
      finding(
        "AXONFLOW-POLICY-FILE-SIZE",
        "Publishable source exceeds the scanner file-size limit",
        rel,
        1,
        `${size} bytes exceeds ${MAX_FILE_BYTES}`,
      ),
    ];
  }

  const text = readFileSync(path, "utf8");
  const credentialSource =
    SECRET_ENV_READ.exec(text) ??
    GENERIC_ENV_ENUMERATION.exec(text) ??
    FILE_SECRET_READ.exec(text);
  const sink = OUTBOUND_SINK.exec(text) ?? PROCESS_SINK.exec(text);
  if (!credentialSource || !sink) {
    return [];
  }

  return [
    finding(
      "AXONFLOW-POLICY-CREDENTIAL-EXFIL",
      "Credential access is co-located with an outbound or process-execution sink",
      rel,
      lineFor(text, Math.min(credentialSource.index, sink.index)),
      `credential source: ${credentialSource[0]}; sink: ${sink[0]}`,
    ),
  ];
}

function scanTree(sourcePath) {
  const root = realpathSync(resolve(sourcePath));
  if (!statSync(root).isDirectory()) {
    throw new Error("sourcePath is not a directory");
  }

  const findings = [];
  const pending = [root];
  let files = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        findings.push(
          finding(
            "AXONFLOW-POLICY-SYMLINK",
            "Publishable plugin archives must not contain symbolic links",
            relative(root, path).split(sep).join("/"),
            1,
            entry.name,
          ),
        );
        continue;
      }
      if (info.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!info.isFile() || !SCANNED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }
      files += 1;
      if (files > MAX_FILES) {
        throw new Error(`source tree exceeds ${MAX_FILES} scanned files`);
      }
      findings.push(...scanFile(root, path));
    }
  }
  return findings;
}

function respond(value) {
  process.stdout.write(JSON.stringify(value));
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) {
    process.stderr.write("install policy request exceeds 1 MiB\n");
    process.exit(1);
  }
});
process.stdin.on("end", () => {
  try {
    const request = JSON.parse(input);
    if (request?.protocolVersion !== 1 || request?.targetType !== "plugin") {
      throw new Error("unsupported install policy request");
    }
    if (typeof request.sourcePath !== "string" || request.sourcePath.length === 0) {
      throw new Error("missing sourcePath");
    }

    const findings = scanTree(request.sourcePath);
    if (findings.length > 0) {
      respond({
        protocolVersion: 1,
        decision: "block",
        reason: "AxonFlow pre-publish policy detected dangerous credential-flow patterns",
        findings: findings.slice(0, 100),
      });
      return;
    }
    respond({ protocolVersion: 1, decision: "allow" });
  } catch (error) {
    process.stderr.write(`install policy failed closed: ${error.message}\n`);
    process.exit(1);
  }
});

