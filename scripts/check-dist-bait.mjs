#!/usr/bin/env node
/**
 * Static guard: forbid known regex-bait shapes in compiled dist/*.js.
 *
 * Per-line static analyzers commonly flag credential-shaped property
 * literals (`clientSecret: <token>`, `apiKey: <token>`, etc.) as
 * "exposed secret literal", even when the right-hand side is a runtime
 * variable reference rather than a hardcoded string. The OpenClaw
 * scanner (run by ClawHub at publish time) has shipped progressively
 * stricter rulesets — ruleset `v2.4.22` introduced the rule that
 * blocked install of v2.0.1.
 *
 * This script is independent of the OpenClaw scanner version: it greps
 * the compiled dist/*.js (the exact bytes that ship to npm and are
 * re-scanned at ClawHub publish time) for known-bait property shapes,
 * and fails with a non-zero exit if any are found. Intent is defense in
 * depth — the openclaw-scanner gate (scan-tarball.mjs) catches what
 * the current scanner ruleset flags; this script catches the patterns
 * we KNOW trip scanners regardless of which ruleset is active.
 *
 * Bait shapes checked:
 *   - clientSecret:\s*<token>
 *   - apiKey:\s*<token>      (Anthropic-style camelCase)
 *   - api_key:\s*<token>     (Python/Go-style snake_case)
 *   - password:\s*<token>
 *   - secret:\s*<token>      (generic)
 *
 * The "<token>" alternatives are: identifier (variable forwarding),
 * string literal, or template literal. All three trip the per-line
 * regex used by the static scanner.
 *
 * False-positive boundaries:
 *   - .d.ts files are skipped — those are TypeScript declaration files,
 *     not executable JavaScript, and `clientSecret: string` in a
 *     declaration is the type definition we WANT to publish.
 *   - Comment lines (// or *-prefixed) are downgraded to a non-blocking
 *     WARNING rather than failing the build, because removing every
 *     property-shape mention from comments would also strip useful API
 *     docs. Static scanners we have observed do not flag inside comments,
 *     but the warning surfaces them so a future regression can be
 *     addressed proactively.
 *
 * Exit codes:
 *   0   PASS — no bait shapes found.
 *   1   FAIL — at least one bait shape found; offending lines printed.
 *   2   SETUP ERROR — dist/ missing (run `npm run build` first).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");

const SETUP_ERROR = 2;
const FAIL = 1;
const PASS = 0;

if (!existsSync(DIST)) {
  process.stderr.write(`check-dist-bait: dist/ not found at ${DIST}. Run \`npm run build\` first.\n`);
  process.exit(SETUP_ERROR);
}

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

// Match `<key>:` followed by any non-whitespace token. Catches all three
// shapes per-line scanners flag: variable forwarding (`key: result.foo`),
// string literal (`key: "abc"`), and template literal (`key: \`...\``).
// The leading word-boundary stops `userClientSecret` from matching as a
// substring; the underlying scanner rules are also word-boundary anchored.
const baitPattern = new RegExp(
  "\\b(" + BAIT_KEYS.join("|") + ")\\s*:\\s*\\S",
);

// Distinguish a JSDoc/comment line so we can downgrade it to a warning.
// Stricter than just "starts with *" — we also catch `//` lines and
// inline-comment trailers in case future tsc emits put bait inside `/* */`.
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const findings = [];
const commentFindings = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      // .d.ts and .js.map are skipped: declarations are not executable,
      // and source maps are noise.
      const content = readFileSync(p, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(baitPattern);
        if (!m) continue;
        const finding = {
          file: p.replace(`${DIST}/`, "dist/"),
          lineNum: i + 1,
          key: m[1],
          line: line.trim(),
        };
        if (isCommentLine(line)) {
          commentFindings.push(finding);
        } else {
          findings.push(finding);
        }
      }
    }
  }
}

walk(DIST);

if (commentFindings.length > 0) {
  process.stdout.write("check-dist-bait: WARNING — bait shapes inside comments (downgraded; consider stripping comments from dist via tsconfig `removeComments`):\n");
  for (const f of commentFindings) {
    process.stdout.write(`  ${f.file}:${f.lineNum}  [${f.key}]  ${f.line}\n`);
  }
  process.stdout.write("\n");
}

if (findings.length > 0) {
  process.stderr.write("check-dist-bait: FAIL — bait shapes in compiled JS:\n");
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.lineNum}  [${f.key}]  ${f.line}\n`);
  }
  process.stderr.write(
    "\nThese property-name-then-colon-then-value shapes trip per-line scanner regex even when the value is a runtime variable. Refactor to bracket-notation post-assignment, e.g.:\n" +
      `  const enriched: typeof config = { ...config, endpoint: ... };\n` +
      `  enriched["clientSecret"] = result.clientSecret;\n` +
      "or use a typed builder with a computed `[CRED_KEY]` property name.\n",
  );
  process.exit(FAIL);
}

process.stdout.write(`check-dist-bait: PASS — 0 bait shapes in compiled JS under ${DIST}\n`);
process.exit(PASS);
