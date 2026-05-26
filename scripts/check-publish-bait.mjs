#!/usr/bin/env node
/**
 * Static guard: forbid sensitive property patterns anywhere in the
 * published tarball.
 *
 * Walks every file that ships to npm (defined by `package.json` `files`)
 * and fails the build if any property-name-then-colon-then-value shape
 * matches a credential key pattern. This catches patterns that static
 * analyzers flag regardless of whether the value is a literal or a
 * runtime variable reference.
 *
 * Checked keys: clientSecret, apiKey, api_key, password, secret.
 *
 * False-positive boundaries:
 *   - .d.ts files inside dist/ are skipped (type declarations).
 *   - Comment lines in compiled JavaScript are downgraded to a
 *     non-blocking warning.
 *
 * Exit codes:
 *   0   PASS — no findings.
 *   1   FAIL — at least one finding in a published file.
 *   2   SETUP ERROR — a configured target is missing (run `npm run build` first).
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const SETUP_ERROR = 2;
const FAIL = 1;
const PASS = 0;

// The list of paths that ship to npm. Mirrors package.json `files`
// exactly. If you add a path to `files`, add it here too — the script
// fails fast if a configured path is missing so a mismatch is visible
// (rather than a configured path silently being skipped).
const PUBLISHED_TARGETS = [
  "dist",
  "policies",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "openclaw.plugin.json",
];

// Bait property names. Word-boundary anchored so we don't match
// substrings like `userClientSecret` (the underlying scanner rules
// also tend to be word-boundary anchored).
const BAIT_KEYS = [
  "clientSecret",
  "apiKey",
  "api_key",
  "password",
  "secret",
];

// Match the bait key followed by colon-then-non-whitespace. Catches
// all shapes per-line scanners flag: variable forwarding, string
// literal, template literal, prose example, YAML value.
const baitPattern = new RegExp(
  "\\b(" + BAIT_KEYS.join("|") + ")\\s*:\\s*\\S",
);

// Distinguish a JSDoc/comment line so we can downgrade compiled-JS
// comments to a warning. The downgrade applies only to .js files;
// markdown and manifest content always fails on a finding.
function isJsCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const findings = [];
const commentFindings = [];

function fileShouldBeScanned(p) {
  if (p.endsWith(".d.ts") || p.endsWith(".d.ts.map") || p.endsWith(".js.map")) {
    return false;
  }
  return /\.(js|ts|md|json|txt)$/.test(p) || p.endsWith("/LICENSE") || p === "LICENSE";
}

function scanFile(absPath, relPath) {
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  const isJs = absPath.endsWith(".js");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(baitPattern);
    if (!m) continue;
    const finding = {
      file: relPath,
      lineNum: i + 1,
      key: m[1],
      line: line.trim().slice(0, 200),
    };
    if (isJs && isJsCommentLine(line)) {
      commentFindings.push(finding);
    } else {
      findings.push(finding);
    }
  }
}

function walk(absPath, relPath) {
  const st = statSync(absPath);
  if (st.isDirectory()) {
    for (const entry of readdirSync(absPath, { withFileTypes: true })) {
      walk(join(absPath, entry.name), join(relPath, entry.name));
    }
  } else if (st.isFile() && fileShouldBeScanned(absPath)) {
    scanFile(absPath, relPath);
  }
}

for (const target of PUBLISHED_TARGETS) {
  const abs = join(REPO_ROOT, target);
  if (!existsSync(abs)) {
    if (target === "dist") {
      process.stderr.write(`check-publish-bait: dist/ not found at ${abs}. Run \`npm run build\` first.\n`);
      process.exit(SETUP_ERROR);
    }
    process.stderr.write(`check-publish-bait: published target ${target} missing at ${abs} — update package.json files or add the path.\n`);
    process.exit(SETUP_ERROR);
  }
  walk(abs, target);
}

if (commentFindings.length > 0) {
  process.stdout.write("check-publish-bait: WARNING — bait shapes inside JS comments (downgraded; consider stripping comments from dist via tsconfig `removeComments`):\n");
  for (const f of commentFindings) {
    process.stdout.write(`  ${f.file}:${f.lineNum}  [${f.key}]  ${f.line}\n`);
  }
  process.stdout.write("\n");
}

if (findings.length > 0) {
  process.stderr.write("check-publish-bait: FAIL — bait shapes in published files:\n");
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.lineNum}  [${f.key}]  ${f.line}\n`);
  }
  process.stderr.write(
    "\nThese property-name-then-colon-then-value shapes are flagged by static analyzers even when the value is documentation, prose, or a runtime variable. For compiled JavaScript, refactor to bracket-notation post-assignment. For markdown / manifest documentation, describe the keys by name and link to the Configuration section instead of embedding placeholder values inline.\n",
  );
  process.exit(FAIL);
}

process.stdout.write("check-publish-bait: PASS — 0 bait shapes in any published file.\n");
process.exit(PASS);
