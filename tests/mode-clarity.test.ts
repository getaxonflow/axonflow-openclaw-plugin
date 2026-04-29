/**
 * Mode-clarity gate (per ADR-048 workstream D3).
 *
 * The mode-clarity canary is the single line of operator-facing logging that
 * tells users — and CI — which AxonFlow they're talking to:
 *
 *   [AxonFlow] Connected to AxonFlow at <url> (mode=<mode>)
 *
 * Two failure modes this gate catches:
 *   1. Canary lies — log line says self-hosted but config or outbound traffic
 *      went to Community SaaS, or vice versa.
 *   2. URL drift — log says try.getaxonflow.com.attacker.com because a
 *      developer used substring matching instead of parsed-URL host comparison.
 *
 * Anti-spoof: every URL assertion uses `new URL(...).host` rather than
 * substring matching, so an endpoint like `https://try.getaxonflow.com.evil/`
 * cannot pass a naive containment check.
 */

import { registerAxonFlowGovernance } from "../src/index.js";

const mockFetch = jest.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  mockFetch.mockReset();
  // Default: every fetch returns 503 so we never hit a real network. Tests
  // that care about the response shape override this on a per-call basis.
  mockFetch.mockResolvedValue(new Response("", { status: 503 }));
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

interface CapturedLogger {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

function makeLogger(): CapturedLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function findCanaryCalls(logger: CapturedLogger): string[] {
  return logger.info.mock.calls
    .map((call) => String(call[0] ?? ""))
    .filter((line) => line.startsWith("[AxonFlow] Connected to AxonFlow at "));
}

function parseCanary(line: string): { url: string; mode: string } {
  // "[AxonFlow] Connected to AxonFlow at <url> (mode=<mode>)"
  const match = line.match(/^\[AxonFlow\] Connected to AxonFlow at (.+) \(mode=(.+)\)$/);
  if (!match) {
    throw new Error(`canary line does not match expected pattern: ${line}`);
  }
  return { url: match[1]!, mode: match[2]! };
}

function fetchedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const call of mockFetch.mock.calls) {
    const url = call[0];
    if (typeof url === "string") {
      try {
        hosts.add(new URL(url).host);
      } catch {
        // Non-URL fetch arg — skip.
      }
    }
  }
  return hosts;
}

describe("mode-clarity canary (ADR-048 D3)", () => {
  it("self-hosted: canary line + config + outbound host all match user-supplied endpoint", () => {
    const logger = makeLogger();
    const userEndpoint = "http://localhost:8080";
    registerAxonFlowGovernance({
      pluginConfig: {
        endpoint: userEndpoint,
        clientId: "tenant-self-hosted",
        clientSecret: "secret-xxx",
      },
      logger,
      on: jest.fn(),
    });

    const canaries = findCanaryCalls(logger);
    expect(canaries).toHaveLength(1);
    const { url, mode } = parseCanary(canaries[0]!);
    // Anti-spoof: parsed-URL host comparison, not substring.
    expect(new URL(url).host).toBe(new URL(userEndpoint).host);
    expect(mode).toBe("self-hosted");

    // Outbound traffic only hits the user-configured host. We don't hit
    // try.getaxonflow.com for self-hosted users — that's the regression a
    // mode-clarity gate must catch.
    const hosts = fetchedHosts();
    if (hosts.size > 0) {
      expect(hosts).toContain(new URL(userEndpoint).host);
      expect(hosts.has("try.getaxonflow.com")).toBe(false);
    }
  });

  it("community-saas: canary line + outbound host both target try.getaxonflow.com", () => {
    const logger = makeLogger();
    registerAxonFlowGovernance({
      // No explicit endpoint/clientId/clientSecret → community-saas default.
      pluginConfig: {},
      logger,
      on: jest.fn(),
    });

    const canaries = findCanaryCalls(logger);
    expect(canaries).toHaveLength(1);
    const { url, mode } = parseCanary(canaries[0]!);
    expect(new URL(url).host).toBe("try.getaxonflow.com");
    expect(mode).toBe("community-saas");

    // The only outbound host (when bootstrap or health check fires) must be
    // try.getaxonflow.com — never localhost, never an attacker-controlled
    // subdomain like `try.getaxonflow.com.evil/`.
    const hosts = fetchedHosts();
    for (const host of hosts) {
      expect(host).toBe("try.getaxonflow.com");
    }
  });

  it("undefined pluginConfig: same as community-saas (no throw)", () => {
    // ADR-048: undefined pluginConfig is "no explicit user choice", which
    // resolves to Community SaaS. This is the case for plugin loaders that
    // pass nothing when no config is configured.
    const logger = makeLogger();
    expect(() =>
      registerAxonFlowGovernance({
        pluginConfig: undefined,
        logger,
        on: jest.fn(),
      }),
    ).not.toThrow();

    const canaries = findCanaryCalls(logger);
    expect(canaries).toHaveLength(1);
    const { url, mode } = parseCanary(canaries[0]!);
    expect(new URL(url).host).toBe("try.getaxonflow.com");
    expect(mode).toBe("community-saas");
  });

  it("partial user config (endpoint only): treated as self-hosted, NOT community-saas", () => {
    // A user who only set AXONFLOW_ENDPOINT but no clientId/clientSecret has
    // explicitly opted into self-hosted; resolveConfig fills clientId with
    // "community" and leaves clientSecret empty. The canary must reflect
    // their explicit endpoint, never silently redirect to try.getaxonflow.com.
    const logger = makeLogger();
    const userEndpoint = "http://my-internal-agent.example.com:9090";
    registerAxonFlowGovernance({
      pluginConfig: { endpoint: userEndpoint },
      logger,
      on: jest.fn(),
    });

    const canaries = findCanaryCalls(logger);
    expect(canaries).toHaveLength(1);
    const { url, mode } = parseCanary(canaries[0]!);
    expect(new URL(url).host).toBe(new URL(userEndpoint).host);
    expect(mode).toBe("self-hosted");

    const hosts = fetchedHosts();
    expect(hosts.has("try.getaxonflow.com")).toBe(false);
  });

  it("anti-spoof: refuses to confuse try.getaxonflow.com.attacker.com with the real one", () => {
    // Defensive: if a user somehow ends up with an attacker-controlled
    // subdomain, the canary URL parsing must distinguish hosts by URL.host,
    // not by substring containment.
    const logger = makeLogger();
    const attackerUrl = "http://try.getaxonflow.com.attacker.com";
    registerAxonFlowGovernance({
      pluginConfig: {
        endpoint: attackerUrl,
        clientId: "tenant",
        clientSecret: "secret",
      },
      logger,
      on: jest.fn(),
    });

    const canaries = findCanaryCalls(logger);
    expect(canaries).toHaveLength(1);
    const { url } = parseCanary(canaries[0]!);
    expect(new URL(url).host).toBe("try.getaxonflow.com.attacker.com");
    // Critical assertion: parsed-host comparison rejects the spoof.
    expect(new URL(url).host).not.toBe("try.getaxonflow.com");
  });
});
