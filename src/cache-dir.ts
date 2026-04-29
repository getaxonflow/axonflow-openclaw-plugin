/**
 * Cross-platform cache directory resolution.
 *
 * Returns a writable per-user cache directory under which the plugin can
 * persist long-lived state (telemetry stamps, Community-SaaS registration).
 * Per OS conventions:
 *   - Linux:  $XDG_CACHE_HOME/axonflow  or  $HOME/.cache/axonflow
 *   - macOS:  $HOME/Library/Caches/axonflow
 *   - Windows: %LOCALAPPDATA%\axonflow  or  %APPDATA%\axonflow
 *
 * Uses Node stdlib only (no third-party deps). On any error, returns the
 * empty string so callers can fall back to "no persistence" without
 * crashing the plugin.
 */

import * as os from "os";
import * as path from "path";

/**
 * Returns the absolute path to the AxonFlow cache directory for this user,
 * or "" if no writable user-cache location can be resolved (e.g. $HOME
 * unset and no platform fallback).
 *
 * Does NOT create the directory. Callers should mkdir it before writing,
 * with mode 0o700 to avoid world-readable credential leakage.
 */
export function axonflowCacheDir(): string {
  // Explicit override wins. Useful for sandboxed containers (read-only HOME),
  // CI test isolation (os.homedir() ignores process.env.HOME on macOS), and
  // users who want to redirect AxonFlow state to a non-default location.
  const override = process.env["AXONFLOW_CACHE_DIR"];
  if (override && override.length > 0) {
    return override;
  }

  const platform = process.platform;
  const home = os.homedir();

  if (platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData && localAppData.length > 0) {
      return path.join(localAppData, "axonflow");
    }
    const appData = process.env["APPDATA"];
    if (appData && appData.length > 0) {
      return path.join(appData, "axonflow");
    }
    if (home) {
      return path.join(home, "AppData", "Local", "axonflow");
    }
    return "";
  }

  if (platform === "darwin") {
    if (home) {
      return path.join(home, "Library", "Caches", "axonflow");
    }
    return "";
  }

  // Linux / *BSD / generic POSIX
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "axonflow");
  }
  if (home) {
    return path.join(home, ".cache", "axonflow");
  }
  return "";
}

/**
 * Returns the absolute path to the AxonFlow config directory for this user,
 * or "" if it can't be resolved. Used for the Community-SaaS registration
 * file (which holds the credential — different lifecycle from cache).
 *
 * Linux: $XDG_CONFIG_HOME/axonflow or $HOME/.config/axonflow
 * macOS: $HOME/Library/Application Support/axonflow
 * Windows: %APPDATA%\axonflow (Roaming) — tied to user identity, syncs across devices
 */
export function axonflowConfigDir(): string {
  const override = process.env["AXONFLOW_CONFIG_DIR"];
  if (override && override.length > 0) {
    return override;
  }

  const platform = process.platform;
  const home = os.homedir();

  if (platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData && appData.length > 0) {
      return path.join(appData, "axonflow");
    }
    if (home) {
      return path.join(home, "AppData", "Roaming", "axonflow");
    }
    return "";
  }

  if (platform === "darwin") {
    if (home) {
      return path.join(home, "Library", "Application Support", "axonflow");
    }
    return "";
  }

  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "axonflow");
  }
  if (home) {
    return path.join(home, ".config", "axonflow");
  }
  return "";
}
