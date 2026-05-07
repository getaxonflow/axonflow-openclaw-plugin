"use strict";

(async () => {
  const fs = require("node:fs");
  const out = process.env.OUT_PATH;

  const { AxonFlowClient } = require(process.env.PLUGIN_DIR + "/dist/axonflow-client.js");
  const { buildAgentTools } = require(process.env.PLUGIN_DIR + "/dist/agent-tools.js");

  const client = new AxonFlowClient({
    endpoint: process.env.AGENT_URL,
    clientId: process.env.TENANT,
    clientSecret: process.env.SECRET,
    requestTimeoutMs: 15000,
  });
  client.setUpgradePromptLogger({
    info: (m) => console.error("[logger.info]", m),
    warn: (m) => console.error("[logger.warn]", m),
    error: (m) => console.error("[logger.error]", m),
  });

  const tools = buildAgentTools({ current: client });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const results = {};

  // Test 1: list_pro_features (Free-accessible) — should round-trip
  // and return the 5-differentiator + pricing shape.
  try {
    const r = await byName["axonflow_list_pro_features"].execute("call-1", {});
    results.list_pro_features = r;
  } catch (e) {
    results.list_pro_features_error = e instanceof Error ? e.message : String(e);
  }

  // Test 2: get_cost_estimate (Pro-only) — Free tier should land the
  // V1 envelope (limit_type=feature_pro_only). Use the underlying
  // callMCPTool directly first so we can see exactly what comes back
  // (kind=envelope/ok/error/throttled), separately from the agent-tool
  // wrapper's translation into ToolResult.
  try {
    const raw = await client.callMCPTool("axonflow_get_cost_estimate", {
      plan: "test-multi-step-plan-for-cost-estimate",
    });
    results.get_cost_estimate_raw = raw;
  } catch (e) {
    results.get_cost_estimate_raw_error = e instanceof Error ? e.message : String(e);
  }
  try {
    const r = await byName["axonflow_get_cost_estimate"].execute("call-2", {
      plan: "test-multi-step-plan-for-cost-estimate",
    });
    results.get_cost_estimate = r;
  } catch (e) {
    results.get_cost_estimate_error = e instanceof Error ? e.message : String(e);
  }

  // The throttle gate from test 2 is now active. Capture the deadline
  // for assertion + clear the file so tests 3 + 4 round-trip
  // (otherwise they'd all return kind="throttled").
  const path = require("node:path");
  const cacheDir = process.env.AXONFLOW_CACHE_DIR;
  if (cacheDir) {
    try {
      const f = path.join(cacheDir, "throttle-until");
      results.throttle_stamp_after_test2 = fs.readFileSync(f, "utf-8").trim();
    } catch (e) { /* not stamped — caller asserts on results.throttle_stamp_after_test2 */ }
    try { fs.unlinkSync(path.join(cacheDir, "throttle-until")); }
    catch (e) { /* file may not exist; ignore */ }
  }

  // Test 3: request_approval (Free=1/7d rolling) — first call should
  // succeed (Free quota: 1 approval per 7d window); plugin pre-test
  // assumes the synthetic tenant has zero existing HITL approvals.
  try {
    const raw = await client.callMCPTool("axonflow_request_approval", {
      original_query: "delete production-east database — runtime-e2e probe",
      request_type: "shell_command",
      trigger_reason: "destructive_command",
      severity: "high",
    });
    results.request_approval_raw = raw;
  } catch (e) {
    results.request_approval_raw_error = e instanceof Error ? e.message : String(e);
  }

  // Test 4: create_tenant_policy (Free=2 active max) — first call
  // should succeed (synthetic tenant starts with zero active
  // policies). Asserting against the API shape, not on side-effects.
  if (cacheDir) {
    try { fs.unlinkSync(path.join(cacheDir, "throttle-until")); } catch {}
  }
  try {
    const raw = await client.callMCPTool("axonflow_create_tenant_policy", {
      name: `runtime-e2e-policy-${Date.now()}`,
      description: "Synthetic policy created by openclaw v1_pro_proxy_tools runtime-e2e",
      connector_type: "openclaw.Bash",
      pattern: "rm -rf /",
      action: "block",
    });
    results.create_tenant_policy_raw = raw;
  } catch (e) {
    results.create_tenant_policy_raw_error = e instanceof Error ? e.message : String(e);
  }

  // Test 5: get_tenant_id — local tool (no MCP round-trip). Sanity
  // check that it's still callable via buildAgentTools (the cross-
  // plugin parity tool).
  if (cacheDir) {
    try { fs.unlinkSync(path.join(cacheDir, "throttle-until")); } catch {}
  }
  try {
    const r = await byName["axonflow_get_tenant_id"].execute("call-5", {});
    results.get_tenant_id = r;
  } catch (e) {
    results.get_tenant_id_error = e instanceof Error ? e.message : String(e);
  }

  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  process.exit(0);
})();
