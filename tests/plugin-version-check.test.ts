import { describe, expect, it, jest } from "@jest/globals";
import {
  compareVersions,
  PLUGIN_ID,
  runPluginVersionCheck,
} from "../src/plugin-version-check.js";

describe("compareVersions", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.0.0", "1.0.1", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.10.0", "1.9.99", 1],
    ["v1.3.2", "1.3.2", 0],
    ["1.0.0-rc1", "1.0.0", 0],
    ["1.0.0+abc", "1.0.0", 0],
    ["1.0", "1.0.0", 0],
    ["", "1.0.0", -1],
  ])("compareVersions(%s, %s) = %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe("runPluginVersionCheck", () => {
  function makeClient(compat: ReturnType<typeof Object> | null) {
    return {
      getPluginCompatibility: jest.fn(async () => compat as never),
    };
  }
  function makeLogger() {
    return {
      warn: jest.fn(),
      info: jest.fn(),
    };
  }

  it("warns when plugin version is below the platform's min", async () => {
    const client = makeClient({
      minPluginVersion: { [PLUGIN_ID]: "2.0.0", claude: "1.0.0" },
      recommendedPluginVersion: { [PLUGIN_ID]: "2.0.0", claude: "1.0.0" },
    });
    const logger = makeLogger();
    await runPluginVersionCheck(client, "1.3.2", logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/below the platform's minimum/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs info when plugin is between min and recommended", async () => {
    const client = makeClient({
      minPluginVersion: { [PLUGIN_ID]: "1.0.0" },
      recommendedPluginVersion: { [PLUGIN_ID]: "1.5.0" },
    });
    const logger = makeLogger();
    await runPluginVersionCheck(client, "1.3.2", logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]![0]).toMatch(/below the recommended/);
  });

  it("stays silent when plugin is at or above the recommended version", async () => {
    const client = makeClient({
      minPluginVersion: { [PLUGIN_ID]: "1.0.0" },
      recommendedPluginVersion: { [PLUGIN_ID]: "1.3.0" },
    });
    const logger = makeLogger();
    await runPluginVersionCheck(client, "1.3.2", logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("stays silent when platform doesn't advertise plugin_compatibility", async () => {
    const client = makeClient(null);
    const logger = makeLogger();
    await runPluginVersionCheck(client, "1.3.2", logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("stays silent when client throws (network error / timeout)", async () => {
    const client = {
      getPluginCompatibility: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const logger = makeLogger();
    await runPluginVersionCheck(client, "1.3.2", logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("stays silent when platform omits the openclaw entry", async () => {
    const client = makeClient({
      minPluginVersion: { claude: "1.0.0", cursor: "1.0.0" },
      recommendedPluginVersion: { claude: "1.0.0", cursor: "1.0.0" },
    });
    const logger = makeLogger();
    await runPluginVersionCheck(client, "1.3.2", logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("does not throw when logger has no warn method", async () => {
    const client = makeClient({
      minPluginVersion: { [PLUGIN_ID]: "2.0.0" },
      recommendedPluginVersion: { [PLUGIN_ID]: "2.0.0" },
    });
    await expect(
      runPluginVersionCheck(client, "1.0.0", {}),
    ).resolves.not.toThrow();
  });
});
