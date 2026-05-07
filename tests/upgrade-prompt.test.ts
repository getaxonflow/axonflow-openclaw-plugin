/**
 * Unit tests for src/upgrade-prompt.ts — V1 Plugin Pro envelope handling.
 *
 * Each test runs in a fresh tmp cache dir so the once-per-day stamp +
 * throttle file don't bleed across cases. Envelope fixtures match the
 * locked wire shape from
 * `axonflow-enterprise/platform/agent/community_saas_ratelimit_response.go`.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  detectEnvelope,
  handleEnvelope,
  isThrottleActive,
  resolveDeadlineMs,
  retryAfterMs,
  shouldShowPromptToday,
  stampThrottle,
  V1_LIMIT_TYPES,
  type V1RateLimitEnvelope,
} from "../src/upgrade-prompt";

function mkCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-upprompt-test-"));
}

function rmCacheDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function makeLogger() {
  const calls: { kind: "info" | "warn" | "error"; msg: string }[] = [];
  const logger = {
    info: (msg: string) => calls.push({ kind: "info", msg }),
    warn: (msg: string) => calls.push({ kind: "warn", msg }),
    error: (msg: string) => calls.push({ kind: "error", msg }),
  };
  return { logger, calls };
}

const dailyQuotaEnvelope: V1RateLimitEnvelope = {
  error: "Daily request limit reached. Resets at midnight UTC.",
  limit_type: "daily_quota",
  tier: "Free",
  limit: 200,
  remaining: 0,
  window: "daily_utc",
  resets_at: "2099-12-31T23:59:59Z",
  upgrade: {
    tier: "Pro",
    wording: "Daily limit reached on Free tier (200 events). Pro raises this to 2,000/day. Resets at midnight UTC.",
    compare_url: "https://getaxonflow.com/pricing/",
    buy_url: "https://buy.stripe.com/bJe28qbztcdVchjdkw8k800",
  },
};

const activePoliciesEnvelope: V1RateLimitEnvelope = {
  error: "Free tier supports 2 active custom policies. Delete one to make room, or Pro removes the cap.",
  limit_type: "active_policies",
  tier: "Free",
  limit: 2,
  remaining: 0,
  upgrade: {
    tier: "Pro",
    wording: "Free tier supports 2 active custom policies. Delete one to make room, or Pro removes the cap.",
    compare_url: "https://getaxonflow.com/pricing/",
    buy_url: "https://buy.stripe.com/bJe28qbztcdVchjdkw8k800",
  },
};

describe("upgrade-prompt", () => {
  describe("detectEnvelope", () => {
    it("detects bare envelope shape", () => {
      const env = detectEnvelope(dailyQuotaEnvelope);
      expect(env).not.toBeNull();
      expect(env?.limit_type).toBe("daily_quota");
    });

    it("detects JSON-RPC wrapped envelope", () => {
      const wrapped = {
        jsonrpc: "2.0",
        id: "x",
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(activePoliciesEnvelope) }],
        },
      };
      const env = detectEnvelope(wrapped);
      expect(env?.limit_type).toBe("active_policies");
    });

    it("returns null on a body without limit_type", () => {
      expect(detectEnvelope({ error: "Generic 429" })).toBeNull();
    });

    it("returns null on a JSON-RPC wrapped non-envelope", () => {
      expect(
        detectEnvelope({
          jsonrpc: "2.0",
          result: { content: [{ type: "text", text: "not json" }] },
        }),
      ).toBeNull();
    });

    it("returns null on null/non-object body", () => {
      expect(detectEnvelope(null)).toBeNull();
      expect(detectEnvelope("string body")).toBeNull();
      expect(detectEnvelope(42)).toBeNull();
    });
  });

  describe("retryAfterMs", () => {
    it("parses integer-second header", () => {
      expect(retryAfterMs("3600")).toBe(3_600_000);
    });

    it("parses HTTP-date header", () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const ms = retryAfterMs(future);
      expect(ms).not.toBeNull();
      // Within ~5s of expected (clock drift on slow runners).
      expect(ms!).toBeGreaterThan(50_000);
      expect(ms!).toBeLessThan(70_000);
    });

    it("returns null on missing/empty header", () => {
      expect(retryAfterMs(null)).toBeNull();
      expect(retryAfterMs(undefined)).toBeNull();
      expect(retryAfterMs("")).toBeNull();
    });

    it("returns null on garbage", () => {
      expect(retryAfterMs("not a number or date")).toBeNull();
    });
  });

  describe("resolveDeadlineMs", () => {
    it("prefers envelope.resets_at when in the future", () => {
      const now = Date.parse("2026-01-01T00:00:00Z");
      const deadline = resolveDeadlineMs(dailyQuotaEnvelope, "60", now);
      // 2099 resets_at (in the future) wins over the 60s Retry-After.
      expect(deadline).toBe(Date.parse("2099-12-31T23:59:59Z"));
    });

    it("falls back to Retry-After when resets_at is in the past", () => {
      const now = Date.now();
      const stale: V1RateLimitEnvelope = {
        ...dailyQuotaEnvelope,
        resets_at: "2020-01-01T00:00:00Z",
      };
      const deadline = resolveDeadlineMs(stale, "60", now);
      expect(deadline).toBe(now + 60_000);
    });

    it("falls back to 60s cooldown when neither resets_at nor Retry-After", () => {
      const now = Date.now();
      const deadline = resolveDeadlineMs(activePoliciesEnvelope, null, now);
      expect(deadline).toBe(now + 60_000);
    });
  });

  describe("isThrottleActive + stampThrottle", () => {
    it("returns false when no stamp file exists", () => {
      const cache = mkCacheDir();
      try {
        expect(isThrottleActive(cache, Date.now())).toBe(false);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("returns true when deadline is in the future", () => {
      const cache = mkCacheDir();
      try {
        const future = Date.now() + 3_600_000;
        stampThrottle(cache, future, "daily_quota");
        expect(isThrottleActive(cache, Date.now())).toBe(true);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("returns false and clears the stamp when deadline is in the past", () => {
      const cache = mkCacheDir();
      try {
        const past = Date.now() - 60_000;
        stampThrottle(cache, past, "daily_quota");
        expect(isThrottleActive(cache, Date.now())).toBe(false);
        expect(fs.existsSync(path.join(cache, "throttle-until"))).toBe(false);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("ignores malformed stamp content", () => {
      const cache = mkCacheDir();
      try {
        fs.mkdirSync(cache, { recursive: true });
        fs.writeFileSync(path.join(cache, "throttle-until"), "garbage\n");
        expect(isThrottleActive(cache, Date.now())).toBe(false);
      } finally {
        rmCacheDir(cache);
      }
    });
  });

  describe("shouldShowPromptToday", () => {
    it("returns true on first run + stamps today", () => {
      const cache = mkCacheDir();
      try {
        const today = new Date("2026-05-07T12:00:00Z");
        expect(shouldShowPromptToday(cache, today)).toBe(true);
        // Second call same UTC day → suppressed.
        expect(shouldShowPromptToday(cache, today)).toBe(false);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("returns true on a new UTC day", () => {
      const cache = mkCacheDir();
      try {
        shouldShowPromptToday(cache, new Date("2026-05-07T12:00:00Z"));
        expect(shouldShowPromptToday(cache, new Date("2026-05-08T01:00:00Z"))).toBe(true);
      } finally {
        rmCacheDir(cache);
      }
    });
  });

  describe("handleEnvelope", () => {
    it("detects daily-quota envelope, surfaces wording, stamps throttle", () => {
      const cache = mkCacheDir();
      try {
        const { logger, calls } = makeLogger();
        const result = handleEnvelope({
          status: 429,
          body: dailyQuotaEnvelope,
          retryAfterHeader: "3600",
          logger,
          cacheDir: cache,
        });
        expect(result.detected).toBe(true);
        expect(result.envelope?.limit_type).toBe("daily_quota");
        expect(result.wordingSurfaced).toBe(true);
        // Wording lands on the logger.
        const infos = calls.filter((c) => c.kind === "info").map((c) => c.msg);
        expect(infos.some((m) => m.includes("Pro raises this to 2,000/day"))).toBe(true);
        expect(infos.some((m) => m.includes("buy.stripe.com/bJe28qbztcdVchjdkw8k800"))).toBe(true);
        // Throttle stamp present + future-dated.
        expect(fs.existsSync(path.join(cache, "throttle-until"))).toBe(true);
        expect(isThrottleActive(cache, Date.now())).toBe(true);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("detects 403 active_policies envelope without resets_at", () => {
      const cache = mkCacheDir();
      try {
        const { logger, calls } = makeLogger();
        const result = handleEnvelope({
          status: 403,
          body: activePoliciesEnvelope,
          retryAfterHeader: null,
          logger,
          cacheDir: cache,
        });
        expect(result.detected).toBe(true);
        expect(result.envelope?.limit_type).toBe("active_policies");
        expect(calls.some((c) => c.msg.includes("Delete one"))).toBe(true);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("detects JSON-RPC wrapped envelope on the MCP path", () => {
      const cache = mkCacheDir();
      try {
        const { logger, calls } = makeLogger();
        const wrapped = {
          jsonrpc: "2.0",
          id: "call-1",
          result: {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(activePoliciesEnvelope) },
            ],
          },
        };
        const result = handleEnvelope({
          status: 403,
          body: wrapped,
          logger,
          cacheDir: cache,
        });
        expect(result.detected).toBe(true);
        expect(calls.some((c) => c.msg.includes("Delete one"))).toBe(true);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("returns detected=false on legacy 429 with no envelope", () => {
      const cache = mkCacheDir();
      try {
        const { logger, calls } = makeLogger();
        const result = handleEnvelope({
          status: 429,
          body: { error: "Rate limit exceeded (20 req/min). Try again shortly." },
          retryAfterHeader: "60",
          logger,
          cacheDir: cache,
        });
        expect(result.detected).toBe(false);
        expect(calls).toHaveLength(0);
        // No throttle stamp on legacy 429 — caller's existing path runs.
        expect(fs.existsSync(path.join(cache, "throttle-until"))).toBe(false);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("returns detected=false for non-4xx status", () => {
      const cache = mkCacheDir();
      try {
        const { logger } = makeLogger();
        for (const status of [200, 204, 500]) {
          const result = handleEnvelope({
            status,
            body: dailyQuotaEnvelope,
            logger,
            cacheDir: cache,
          });
          expect(result.detected).toBe(false);
        }
      } finally {
        rmCacheDir(cache);
      }
    });

    it("once-per-UTC-day stamp suppresses wording on second invocation", () => {
      const cache = mkCacheDir();
      try {
        const today = new Date("2026-05-07T12:00:00Z");
        const { logger: log1, calls: calls1 } = makeLogger();
        handleEnvelope({
          status: 429,
          body: dailyQuotaEnvelope,
          retryAfterHeader: "60",
          logger: log1,
          cacheDir: cache,
          now: today,
        });
        const { logger: log2, calls: calls2 } = makeLogger();
        const result2 = handleEnvelope({
          status: 429,
          body: dailyQuotaEnvelope,
          retryAfterHeader: "60",
          logger: log2,
          cacheDir: cache,
          now: today, // same UTC day
        });
        expect(calls1.some((c) => c.msg.includes("2,000/day"))).toBe(true);
        expect(result2.detected).toBe(true);
        expect(result2.wordingSurfaced).toBe(false);
        expect(calls2.some((c) => c.msg.includes("2,000/day"))).toBe(false);
      } finally {
        rmCacheDir(cache);
      }
    });

    it("rejects an unknown limit_type so old plugins survive future server rollouts", () => {
      const cache = mkCacheDir();
      try {
        const { logger, calls } = makeLogger();
        const result = handleEnvelope({
          status: 429,
          body: { ...dailyQuotaEnvelope, limit_type: "unknown_future_cap" },
          logger,
          cacheDir: cache,
        });
        expect(result.detected).toBe(false);
        expect(calls).toHaveLength(0);
      } finally {
        rmCacheDir(cache);
      }
    });
  });

  describe("V1_LIMIT_TYPES locked enumeration", () => {
    it("includes the four V1 limit types plus the V1.1 decision_list_size addition", () => {
      // V1.1 (#1982) extends the original V1 set with decision_list_size
      // for the GET /api/v1/decisions cap-hit path. Adding to this list
      // is a coordinated cross-surface change with the platform's
      // limitTypeDecisionListSize constant in
      // platform/orchestrator/decisions_list_handler.go — keep in sync.
      expect([...V1_LIMIT_TYPES].sort()).toEqual([
        "active_policies",
        "daily_quota",
        "decision_list_size",
        "feature_pro_only",
        "hitl_approvals_window",
      ]);
    });
  });
});
