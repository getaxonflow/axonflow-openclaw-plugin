#!/usr/bin/env node
/**
 * Wire-shape contract gate — PR-blocking validator.
 *
 * Compares the OpenClaw plugin's wire-bound TS interfaces (declared in
 * src/axonflow-client.ts) against the AxonFlow agent's OpenAPI spec at
 * the SHA pinned in tests/fixtures/wire-shape-baseline.json. Fails on
 * drift NOT covered by the baseline.
 *
 * Usage:
 *   AXONFLOW_OPENAPI_SPECS_DIR=/path/to/specs/dir node scripts/wire-shape/validate.js
 *
 * Exit 0: clean, or drift is fully covered by baseline
 * Exit 1: drift OUTSIDE baseline (PR-blocking)
 */

'use strict';

const path = require('path');
const {
  extractInterfaces,
  loadSchemas,
  computeDrift,
  loadBaseline,
  WIRE_BOUND,
} = require('./lib.cjs');

function main() {
  const specsDir = process.env.AXONFLOW_OPENAPI_SPECS_DIR;
  if (!specsDir) {
    console.log('⏭️  AXONFLOW_OPENAPI_SPECS_DIR not set; wire-shape gate skipped.');
    console.log('    The dedicated CI job clones getaxonflow/axonflow at the pinned');
    console.log('    SHA and exports this variable before running the validator.');
    process.exit(0);
  }

  const interfaces = extractInterfaces();
  const schemas = loadSchemas(specsDir);
  const { drift, unmapped_in_spec } = computeDrift(interfaces, schemas);
  const baseline = loadBaseline();

  const baseDrift = baseline.per_type_drift || {};
  const baseUnmapped = baseline.unmapped_in_spec || [];

  // 1. New drift (per-type field-set mismatches not in baseline).
  const newDrift = [];
  for (const [name, d] of Object.entries(drift)) {
    const expected = baseDrift[name] || { sdk_only: [], spec_only: [] };
    const newSdkOnly = d.sdk_only.filter((f) => !(expected.sdk_only || []).includes(f));
    const newSpecOnly = d.spec_only.filter((f) => !(expected.spec_only || []).includes(f));
    if (newSdkOnly.length > 0 || newSpecOnly.length > 0) {
      newDrift.push({ name, newSdkOnly, newSpecOnly, expected });
    }
  }

  // 2. Newly-unmapped types (in plugin, no spec match — Cat C candidates).
  const newUnmapped = unmapped_in_spec.filter((n) => !baseUnmapped.includes(n));

  // 3. Stale baseline entries — burned down without refresh.
  const staleDrift = [];
  for (const name of Object.keys(baseDrift)) {
    if (!drift[name]) staleDrift.push(name);
  }
  const staleUnmapped = baseUnmapped.filter((n) => !unmapped_in_spec.includes(n));

  let failed = false;

  if (newDrift.length > 0) {
    console.error('::error::wire-shape: NEW per-type drift not in baseline');
    for (const { name, newSdkOnly, newSpecOnly } of newDrift) {
      console.error(`  ${name}:`);
      if (newSdkOnly.length > 0) console.error(`    NEW plugin-only: ${newSdkOnly.join(', ')}`);
      if (newSpecOnly.length > 0) console.error(`    NEW spec-only:   ${newSpecOnly.join(', ')}`);
    }
    console.error('');
    console.error(
      'Fix: align the plugin interface with the spec, OR (if the SDK is the source of truth) update the spec, OR refresh the baseline with --write-baseline if this is a deliberate burndown queue addition tracked separately.',
    );
    failed = true;
  }

  if (newUnmapped.length > 0) {
    console.error('::error::wire-shape: NEW unmapped types (plugin has them, spec doesn\'t)');
    for (const n of newUnmapped) {
      console.error(`  ${n} (mapped to spec name "${WIRE_BOUND[n]}")`);
    }
    console.error('');
    console.error(
      'Either the spec needs to gain the schema (file a platform-side issue), or mark the type @sdkDerived if it\'s a plugin-side derivation that won\'t live on the wire.',
    );
    failed = true;
  }

  if (staleDrift.length > 0 || staleUnmapped.length > 0) {
    console.error('::error::wire-shape: stale baseline entries — burned down but baseline still lists');
    for (const n of staleDrift) console.error(`  drift: ${n}`);
    for (const n of staleUnmapped) console.error(`  unmapped: ${n}`);
    console.error('');
    console.error('Re-run with --write-baseline to refresh.');
    failed = true;
  }

  if (failed) process.exit(1);

  const driftCount = Object.keys(drift).length;
  const unmappedCount = unmapped_in_spec.length;
  console.log(
    `wire-shape: clean — ${driftCount} per-type drift entry(ies), ${unmappedCount} unmapped type(s), all baselined. Burndown queue.`,
  );
  process.exit(0);
}

main();
