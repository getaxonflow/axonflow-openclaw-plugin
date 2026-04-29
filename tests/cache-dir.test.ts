/**
 * Tests for cross-platform cache/config dir resolution.
 *
 * Branch coverage matters here — the resolution table is the single
 * source of truth for where the plugin persists Community-SaaS
 * registration and telemetry stamps. A regression that quietly drops
 * one OS branch ships a half-broken plugin to those users.
 */

import * as path from "path";

let homedirValue = "/default";
jest.mock("os", () => {
  const actual = jest.requireActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => homedirValue,
  };
});

import { axonflowCacheDir, axonflowConfigDir } from "../src/cache-dir.js";

const originalEnv = { ...process.env };
const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function mockHomedir(value: string): void {
  homedirValue = value;
}

afterEach(() => {
  process.env = { ...originalEnv };
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  homedirValue = "/default";
});

describe("axonflowCacheDir", () => {
  beforeEach(() => {
    delete process.env.AXONFLOW_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
  });

  it("returns AXONFLOW_CACHE_DIR override when set", () => {
    process.env.AXONFLOW_CACHE_DIR = "/sandbox/axonflow";
    expect(axonflowCacheDir()).toBe("/sandbox/axonflow");
  });

  it("ignores empty AXONFLOW_CACHE_DIR override", () => {
    process.env.AXONFLOW_CACHE_DIR = "";
    setPlatform("linux");
    mockHomedir("/home/u");
    expect(axonflowCacheDir()).toBe(path.join("/home/u", ".cache", "axonflow"));
  });

  it("Linux: uses XDG_CACHE_HOME when set", () => {
    setPlatform("linux");
    process.env.XDG_CACHE_HOME = "/var/cache/me";
    mockHomedir("/home/u");
    expect(axonflowCacheDir()).toBe(path.join("/var/cache/me", "axonflow"));
  });

  it("Linux: falls back to $HOME/.cache when XDG unset", () => {
    setPlatform("linux");
    mockHomedir("/home/u");
    expect(axonflowCacheDir()).toBe(path.join("/home/u", ".cache", "axonflow"));
  });

  it("Linux: returns empty when neither XDG nor HOME available", () => {
    setPlatform("linux");
    mockHomedir("");
    expect(axonflowCacheDir()).toBe("");
  });

  it("macOS: uses Library/Caches under HOME", () => {
    setPlatform("darwin");
    mockHomedir("/Users/u");
    expect(axonflowCacheDir()).toBe(path.join("/Users/u", "Library", "Caches", "axonflow"));
  });

  it("macOS: returns empty when HOME unavailable", () => {
    setPlatform("darwin");
    mockHomedir("");
    expect(axonflowCacheDir()).toBe("");
  });

  it("Windows: prefers LOCALAPPDATA over APPDATA", () => {
    setPlatform("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\me\\AppData\\Local";
    process.env.APPDATA = "C:\\Users\\me\\AppData\\Roaming";
    expect(axonflowCacheDir()).toBe(path.join("C:\\Users\\me\\AppData\\Local", "axonflow"));
  });

  it("Windows: falls back to APPDATA when LOCALAPPDATA unset", () => {
    setPlatform("win32");
    process.env.APPDATA = "C:\\Users\\me\\AppData\\Roaming";
    expect(axonflowCacheDir()).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "axonflow"));
  });

  it("Windows: derives from HOME when neither AppData var is set", () => {
    setPlatform("win32");
    mockHomedir("C:\\Users\\me");
    expect(axonflowCacheDir()).toBe(path.join("C:\\Users\\me", "AppData", "Local", "axonflow"));
  });

  it("Windows: returns empty when nothing is resolvable", () => {
    setPlatform("win32");
    mockHomedir("");
    expect(axonflowCacheDir()).toBe("");
  });
});

describe("axonflowConfigDir", () => {
  beforeEach(() => {
    delete process.env.AXONFLOW_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
  });

  it("returns AXONFLOW_CONFIG_DIR override when set", () => {
    process.env.AXONFLOW_CONFIG_DIR = "/sandbox/cfg";
    expect(axonflowConfigDir()).toBe("/sandbox/cfg");
  });

  it("Linux: uses XDG_CONFIG_HOME when set", () => {
    setPlatform("linux");
    process.env.XDG_CONFIG_HOME = "/etc/me";
    expect(axonflowConfigDir()).toBe(path.join("/etc/me", "axonflow"));
  });

  it("Linux: falls back to $HOME/.config when XDG unset", () => {
    setPlatform("linux");
    mockHomedir("/home/u");
    expect(axonflowConfigDir()).toBe(path.join("/home/u", ".config", "axonflow"));
  });

  it("Linux: returns empty when nothing resolvable", () => {
    setPlatform("linux");
    mockHomedir("");
    expect(axonflowConfigDir()).toBe("");
  });

  it("macOS: uses Library/Application Support under HOME", () => {
    setPlatform("darwin");
    mockHomedir("/Users/u");
    expect(axonflowConfigDir()).toBe(
      path.join("/Users/u", "Library", "Application Support", "axonflow"),
    );
  });

  it("macOS: returns empty when HOME unavailable", () => {
    setPlatform("darwin");
    mockHomedir("");
    expect(axonflowConfigDir()).toBe("");
  });

  it("Windows: uses APPDATA (Roaming, not Local — config is user-tied)", () => {
    setPlatform("win32");
    process.env.APPDATA = "C:\\Users\\me\\AppData\\Roaming";
    expect(axonflowConfigDir()).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "axonflow"));
  });

  it("Windows: falls back to HOME-derived path when APPDATA unset", () => {
    setPlatform("win32");
    mockHomedir("C:\\Users\\me");
    expect(axonflowConfigDir()).toBe(path.join("C:\\Users\\me", "AppData", "Roaming", "axonflow"));
  });

  it("Windows: returns empty when nothing is resolvable", () => {
    setPlatform("win32");
    mockHomedir("");
    expect(axonflowConfigDir()).toBe("");
  });
});
