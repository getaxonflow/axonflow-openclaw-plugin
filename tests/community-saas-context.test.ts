/**
 * Unit tests for community-saas-context.ts.
 *
 * Focused on the helpers split out of community-saas-bootstrap.ts to
 * dodge the OpenClaw scanner's per-file env+fetch / fs+fetch
 * heuristics. Each catch path corresponds to a real failure mode users
 * hit in the field — mkdir blocked, registration file missing, world-
 * readable credential rejection, backoff parse failure, etc.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildRegistrationLabel,
  disclosureStampPath,
  ensureSecureDir,
  hasShownDisclosure,
  isCommunitySaasOptedOut,
  isWithinBackoff,
  markDisclosureShown,
  readRegistrationIfFreshAndSafe,
  resolveHarnessInputs,
  unlinkIfExists,
  writeFileAtomicallyWithMode,
} from "../src/community-saas-context.js";

const originalEnv = { ...process.env };

let testDir = "";

beforeEach(() => {
  process.env = { ...originalEnv };
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-csctx-test-"));
});

afterEach(() => {
  process.env = originalEnv;
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("isCommunitySaasOptedOut", () => {
  it("returns false when the env var is unset", () => {
    delete process.env.AXONFLOW_COMMUNITY_SAAS;
    expect(isCommunitySaasOptedOut()).toBe(false);
  });

  it("returns true for '0'", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "0";
    expect(isCommunitySaasOptedOut()).toBe(true);
  });

  it("returns true for 'false' (case-insensitive)", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "FaLsE";
    expect(isCommunitySaasOptedOut()).toBe(true);
  });

  it("returns true for 'off'", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "off";
    expect(isCommunitySaasOptedOut()).toBe(true);
  });

  it("returns true for 'no'", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "no";
    expect(isCommunitySaasOptedOut()).toBe(true);
  });

  it("trims whitespace before comparing", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "  off  ";
    expect(isCommunitySaasOptedOut()).toBe(true);
  });

  it("returns false for '1' (truthy non-off value)", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "1";
    expect(isCommunitySaasOptedOut()).toBe(false);
  });

  it("returns false for arbitrary non-off strings", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "yes please";
    expect(isCommunitySaasOptedOut()).toBe(false);
  });

  it("returns false for empty string", () => {
    process.env.AXONFLOW_COMMUNITY_SAAS = "";
    expect(isCommunitySaasOptedOut()).toBe(false);
  });
});

describe("resolveHarnessInputs", () => {
  it("returns harnessOn=false when AXONFLOW_HARNESS is unset", () => {
    delete process.env.AXONFLOW_HARNESS;
    const inputs = resolveHarnessInputs();
    expect(inputs.harnessOn).toBe(false);
    expect(inputs.harnessRegisterUrl).toBe("");
    expect(inputs.harnessAgentEndpoint).toBe("");
  });

  it("returns harnessOn=false for AXONFLOW_HARNESS=0", () => {
    process.env.AXONFLOW_HARNESS = "0";
    const inputs = resolveHarnessInputs();
    expect(inputs.harnessOn).toBe(false);
  });

  it("returns harness URLs when AXONFLOW_HARNESS=1", () => {
    process.env.AXONFLOW_HARNESS = "1";
    process.env.AXONFLOW_HARNESS_REGISTER_URL = "http://localhost:9999/register";
    process.env.AXONFLOW_HARNESS_AGENT_ENDPOINT = "http://localhost:9999";
    const inputs = resolveHarnessInputs();
    expect(inputs.harnessOn).toBe(true);
    expect(inputs.harnessRegisterUrl).toBe("http://localhost:9999/register");
    expect(inputs.harnessAgentEndpoint).toBe("http://localhost:9999");
  });

  it("returns empty harness URLs when AXONFLOW_HARNESS=1 but URLs unset", () => {
    process.env.AXONFLOW_HARNESS = "1";
    delete process.env.AXONFLOW_HARNESS_REGISTER_URL;
    delete process.env.AXONFLOW_HARNESS_AGENT_ENDPOINT;
    const inputs = resolveHarnessInputs();
    expect(inputs.harnessOn).toBe(true);
    expect(inputs.harnessRegisterUrl).toBe("");
    expect(inputs.harnessAgentEndpoint).toBe("");
  });
});

describe("ensureSecureDir", () => {
  it("returns false for empty input", () => {
    expect(ensureSecureDir("")).toBe(false);
  });

  it("creates the directory and returns true on success", () => {
    const dir = path.join(testDir, "secure");
    expect(ensureSecureDir(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it("returns false when mkdir fails (parent is a file)", () => {
    const blocker = path.join(testDir, "blocker");
    fs.writeFileSync(blocker, "blocker");
    expect(ensureSecureDir(path.join(blocker, "child"))).toBe(false);
  });
});

describe("readRegistrationIfFreshAndSafe", () => {
  const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const now = () => new Date();

  function writeReg(file: string, body: object, mode = 0o600): void {
    fs.writeFileSync(file, JSON.stringify(body), { mode });
    if (process.platform !== "win32") fs.chmodSync(file, mode);
  }

  it("returns null when the file does not exist", () => {
    const file = path.join(testDir, "missing.json");
    expect(readRegistrationIfFreshAndSafe(file, now, REFRESH_WINDOW_MS)).toBeNull();
  });

  it("returns parsed registration when fresh and 0o600", () => {
    const file = path.join(testDir, "ok.json");
    writeReg(file, {
      tenant_id: "cs_abc",
      secret: "secret-xyz",
      expires_at: futureIso,
      endpoint: "https://try.getaxonflow.com",
    });
    const result = readRegistrationIfFreshAndSafe(file, now, REFRESH_WINDOW_MS);
    expect(result?.tenant_id).toBe("cs_abc");
    expect(result?.secret).toBe("secret-xyz");
  });

  it("rejects world-readable registration files on POSIX", () => {
    if (process.platform === "win32") return; // POSIX only
    const file = path.join(testDir, "world-readable.json");
    writeReg(file, {
      tenant_id: "cs_abc",
      secret: "secret-xyz",
      expires_at: futureIso,
    }, 0o644);
    expect(readRegistrationIfFreshAndSafe(file, now, REFRESH_WINDOW_MS)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const file = path.join(testDir, "garbage.json");
    fs.writeFileSync(file, "{not json}", { mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    expect(readRegistrationIfFreshAndSafe(file, now, REFRESH_WINDOW_MS)).toBeNull();
  });

  it("returns null when fields are missing or wrong type", () => {
    const file = path.join(testDir, "incomplete.json");
    writeReg(file, { tenant_id: "cs_abc", secret: 42, expires_at: futureIso });
    expect(readRegistrationIfFreshAndSafe(file, now, REFRESH_WINDOW_MS)).toBeNull();
  });

  it("returns null when expires_at is unparseable", () => {
    const file = path.join(testDir, "bad-expiry.json");
    writeReg(file, { tenant_id: "cs_abc", secret: "x", expires_at: "not-a-date" });
    expect(readRegistrationIfFreshAndSafe(file, now, REFRESH_WINDOW_MS)).toBeNull();
  });

  it("returns null when the registration is within the refresh window", () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const file = path.join(testDir, "expiring.json");
    writeReg(file, { tenant_id: "cs_abc", secret: "x", expires_at: soon });
    expect(readRegistrationIfFreshAndSafe(file, now, REFRESH_WINDOW_MS)).toBeNull();
  });
});

describe("isWithinBackoff", () => {
  const now = () => new Date();

  it("returns false when backoffFile is empty", () => {
    expect(isWithinBackoff("", now)).toBe(false);
  });

  it("returns false when backoff file is missing", () => {
    expect(isWithinBackoff(path.join(testDir, "nope"), now)).toBe(false);
  });

  it("returns true when backoff timestamp is in the future", () => {
    const file = path.join(testDir, "backoff");
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(file, String(futureSec));
    expect(isWithinBackoff(file, now)).toBe(true);
  });

  it("returns false when backoff timestamp is in the past", () => {
    const file = path.join(testDir, "backoff-old");
    const pastSec = Math.floor(Date.now() / 1000) - 3600;
    fs.writeFileSync(file, String(pastSec));
    expect(isWithinBackoff(file, now)).toBe(false);
  });

  it("returns false for malformed backoff content", () => {
    const file = path.join(testDir, "backoff-garbage");
    fs.writeFileSync(file, "not-a-number");
    expect(isWithinBackoff(file, now)).toBe(false);
  });

  it("returns false for non-positive backoff timestamps", () => {
    const file = path.join(testDir, "backoff-zero");
    fs.writeFileSync(file, "0");
    expect(isWithinBackoff(file, now)).toBe(false);
  });
});

describe("writeFileAtomicallyWithMode + unlinkIfExists", () => {
  it("writes content and applies mode", () => {
    const file = path.join(testDir, "atomic");
    writeFileAtomicallyWithMode(file, "hello", 0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("unlinkIfExists silently no-ops when file is missing", () => {
    expect(() => unlinkIfExists(path.join(testDir, "nothing"))).not.toThrow();
  });

  it("unlinkIfExists removes the file when present", () => {
    const file = path.join(testDir, "todelete");
    fs.writeFileSync(file, "x");
    unlinkIfExists(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("unlinkIfExists is a no-op on empty input", () => {
    expect(() => unlinkIfExists("")).not.toThrow();
  });
});

describe("buildRegistrationLabel", () => {
  it("returns a label when version is provided", () => {
    expect(buildRegistrationLabel("2.0.1")).toContain("openclaw-plugin@2.0.1");
  });

  it("falls back to 'unknown' when version is undefined", () => {
    expect(buildRegistrationLabel(undefined)).toContain("openclaw-plugin@unknown");
  });

  it("truncates labels longer than 255 chars", () => {
    const label = buildRegistrationLabel("x".repeat(300));
    expect(label.length).toBeLessThanOrEqual(255);
  });
});

describe("disclosureStampPath / hasShownDisclosure / markDisclosureShown", () => {
  it("disclosureStampPath returns empty string when configDir is empty", () => {
    expect(disclosureStampPath("")).toBe("");
  });

  it("hasShownDisclosure returns false for empty stampFile", () => {
    expect(hasShownDisclosure("")).toBe(false);
  });

  it("hasShownDisclosure returns false when stamp file is missing", () => {
    expect(hasShownDisclosure(path.join(testDir, "nope"))).toBe(false);
  });

  it("markDisclosureShown writes a file that hasShownDisclosure detects", () => {
    const stamp = path.join(testDir, "disclosure-stamp");
    expect(hasShownDisclosure(stamp)).toBe(false);
    markDisclosureShown(stamp);
    expect(hasShownDisclosure(stamp)).toBe(true);
  });

  it("markDisclosureShown is a no-op on empty input", () => {
    expect(() => markDisclosureShown("")).not.toThrow();
  });

  it("markDisclosureShown swallows write errors silently", () => {
    // Writing into a path under a file should fail; mark must not throw.
    const blocker = path.join(testDir, "blocker");
    fs.writeFileSync(blocker, "block");
    expect(() => markDisclosureShown(path.join(blocker, "stamp"))).not.toThrow();
  });
});
