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

  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  process.exit(0);
})();
