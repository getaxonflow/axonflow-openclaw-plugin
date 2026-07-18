/**
 * Suite-level hermeticity for environment-sourced configuration.
 *
 * `resolveConfig()` / `resolveStatusInputs()` read `AXONFLOW_ENDPOINT`
 * from the process environment (#162, via src/endpoint-env.ts). Developer
 * and e2e-driver shells commonly export that variable, which would
 * silently flip every endpoint/mode expectation in the unit suites to the
 * ambient value. Clear it once per test file; tests that exercise the env
 * path set it explicitly and save/restore around themselves.
 */
delete process.env.AXONFLOW_ENDPOINT;
