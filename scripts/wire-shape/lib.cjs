#!/usr/bin/env node
/**
 * Wire-shape contract gate — shared helpers.
 *
 * The OpenClaw plugin imports MCP-response shapes from the AxonFlow agent.
 * This gate diffs the plugin's local interface declarations against the
 * agent's OpenAPI spec at a pinned SHA and fails on drift not in baseline.
 *
 * Mirrors the conceptual model of the four AxonFlow SDKs' wire-shape
 * gates (see ADR-047). Plugin scope is much smaller (6 wire-bound types
 * vs 60+ on SDKs) so the gate is intentionally lean — no transformer
 * walk, no snake/camel case bridging, no cross-spec divergence detector.
 *
 *   - Authoritative source: OpenAPI spec, loaded from a directory whose
 *     path comes from $AXONFLOW_OPENAPI_SPECS_DIR. CI checks out the
 *     getaxonflow/axonflow community mirror at the SHA pinned in the
 *     baseline JSON.
 *   - Wire-bound interfaces: declared in WIRE_BOUND in this file.
 *   - Drift: per-interface set diff between plugin and spec.
 *   - Baseline: tests/fixtures/wire-shape-baseline.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CLIENT_TS = path.join(PLUGIN_ROOT, 'src', 'axonflow-client.ts');
const BASELINE_PATH = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'wire-shape-baseline.json');

/**
 * Map: plugin TS interface name → OpenAPI schema name.
 * Same name on both sides for most types; CreateOverrideResult is the
 * plugin's view of the agent's create-override response — mapped to
 * CreateOverrideResponse (the dedicated create-response schema added
 * in platform v7.4.4), distinct from the at-rest PolicyOverride
 * entity which is what GET endpoints return.
 */
const WIRE_BOUND = {
  MCPCheckInputResponse: 'MCPCheckInputResponse',
  MCPCheckOutputResponse: 'MCPCheckOutputResponse',
  ExplainPolicy: 'ExplainPolicy',
  ExplainRule: 'ExplainRule',
  DecisionExplanation: 'DecisionExplanation',
  CreateOverrideResult: 'CreateOverrideResponse',
};

/**
 * Walk axonflow-client.ts and extract every exported interface's
 * property names. Returns a Map<string, string[]> keyed by interface
 * name. Property names are kept in source order (sorted for diff at
 * comparison time).
 */
function extractInterfaces() {
  if (!fs.existsSync(CLIENT_TS)) {
    throw new Error(`expected ${CLIENT_TS} to exist`);
  }
  const text = fs.readFileSync(CLIENT_TS, 'utf8');
  const sourceFile = ts.createSourceFile(CLIENT_TS, text, ts.ScriptTarget.Latest, true);
  const result = new Map();

  function visit(node) {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.modifiers &&
      node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const name = node.name.text;
      const props = [];
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          const propName =
            member.name.text || (member.name.escapedText && member.name.escapedText.toString());
          if (propName) props.push(propName);
        }
      }
      result.set(name, props);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return result;
}

/**
 * Load every *.yaml file in a spec directory and return a map of
 * schema name → sorted property names. Last-loaded declaration wins
 * on cross-spec name collision.
 *
 * Plugin gate doesn't track cross-spec divergences (the SDK gates do
 * — that's the platform's concern).
 */
/**
 * Walk YAML files via parseDocument so duplicate-key declarations don't
 * crash the parser (e.g. orchestrator-api.yaml has historically carried
 * PolicyMatch declared twice — known platform bug, filed separately).
 * Iterate items directly with last-wins on cross-spec collision.
 */
function loadSchemas(specsDir) {
  const YAML = require('yaml');
  const merged = {};
  const files = fs
    .readdirSync(specsDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(specsDir, file), 'utf8');
    const doc = YAML.parseDocument(text);
    const schemasNode = findSchemasNode(doc);
    if (!schemasNode) continue;
    for (const pair of schemasNode.items) {
      const name = pair.key && pair.key.value;
      if (typeof name !== 'string') continue;
      const schemaValue = pair.value;
      if (!schemaValue || !schemaValue.items) continue;
      const fields = extractFieldsFromNode(schemaValue);
      if (fields != null) merged[name] = fields;
    }
  }
  return merged;
}

function findSchemasNode(doc) {
  const top = doc.contents;
  if (!top || !top.items) return null;
  const components = findMapChild(top, 'components');
  if (!components || !components.items) return null;
  return findMapChild(components, 'schemas');
}

function findMapChild(mapNode, key) {
  for (const pair of mapNode.items) {
    const k = pair.key && pair.key.value;
    if (k === key) return pair.value;
  }
  return null;
}

function extractFieldsFromNode(schemaValue) {
  const props = findMapChild(schemaValue, 'properties');
  if (props && props.items) {
    return props.items
      .map((p) => p.key && p.key.value)
      .filter((v) => typeof v === 'string')
      .sort();
  }
  const allOf = findMapChild(schemaValue, 'allOf');
  if (allOf && Array.isArray(allOf.items)) {
    const all = new Set();
    for (const sub of allOf.items) {
      const subFields = extractFieldsFromNode(sub);
      if (subFields) for (const f of subFields) all.add(f);
    }
    if (all.size > 0) return [...all].sort();
  }
  return null;
}

/**
 * Compute drift per registered type.
 *
 * Returns:
 *   {
 *     drift: { [pluginType]: { sdk_only: [], spec_only: [] } },
 *     unmapped_in_spec: [pluginType] -- spec has no schema with the
 *                                       mapped name; treated as Cat C.
 *   }
 */
function computeDrift(interfaces, schemas) {
  const drift = {};
  const unmappedInSpec = [];
  for (const [pluginName, schemaName] of Object.entries(WIRE_BOUND)) {
    if (!interfaces.has(pluginName)) {
      throw new Error(
        `WIRE_BOUND lists ${pluginName} but axonflow-client.ts has no exported interface by that name. Update the registry or restore the interface.`,
      );
    }
    const pluginFields = [...interfaces.get(pluginName)].sort();
    const specFields = schemas[schemaName];
    if (specFields == null) {
      unmappedInSpec.push(pluginName);
      continue;
    }
    if (arraysEqual(pluginFields, specFields)) continue;
    drift[pluginName] = {
      sdk_only: pluginFields.filter((f) => !specFields.includes(f)),
      spec_only: specFields.filter((f) => !pluginFields.includes(f)),
    };
  }
  return { drift, unmapped_in_spec: unmappedInSpec.sort() };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(`baseline missing: ${BASELINE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(out) {
  const tmp = BASELINE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, BASELINE_PATH);
}

module.exports = {
  PLUGIN_ROOT,
  BASELINE_PATH,
  WIRE_BOUND,
  extractInterfaces,
  loadSchemas,
  computeDrift,
  loadBaseline,
  writeBaseline,
};
