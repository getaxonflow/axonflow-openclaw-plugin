/**
 * Suite-level hermeticity for environment-sourced configuration.
 *
 * `resolveConfig()` / `resolveStatusInputs()` read `AXONFLOW_ENDPOINT`
 * from the process environment (#162, via src/endpoint-env.ts). Developer
 * and e2e-driver shells commonly export that variable, which would
 * silently flip every endpoint/mode expectation in the unit suites to the
 * ambient value. Clear it once per test file; tests that exercise the env
 * path set it explicitly and save/restore around themselves.
 *
 * `AXONFLOW_CONFIG_DIR` is pinned to a throwaway directory for the same
 * reason, with an added stake since #167: `registerAxonFlowGovernance()`
 * writes the plugin runtime-state record at load and `resolveStatusInputs()`
 * reads it back. Without a pin, every test that registers the plugin would
 * write into the developer's real AxonFlow config directory, and every
 * status test would resolve against whatever that machine happens to have
 * registered — the suite would pass or fail based on the host. Each jest
 * worker gets its own pid-scoped directory so parallel workers cannot see
 * each other's records.
 *
 * Tests that need to drive the config dir explicitly keep using the
 * `configDirOverride` input, which takes precedence over this pin.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

delete process.env.AXONFLOW_ENDPOINT;

const isolatedConfigDir = path.join(
  os.tmpdir(),
  `axonflow-openclaw-jest-config-${process.pid}`,
);
fs.mkdirSync(isolatedConfigDir, { recursive: true, mode: 0o700 });
process.env.AXONFLOW_CONFIG_DIR = isolatedConfigDir;
