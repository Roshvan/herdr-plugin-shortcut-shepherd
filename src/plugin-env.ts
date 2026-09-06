import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "./result.ts";

/** Globally registered plugin ID. */
export const PLUGIN_ID = "roshvan.shortcut-shepherd";

/** Parsed invocation environment; socket context is mandatory to avoid targeting another session. */
export type PluginEnv = {
  readonly socketPath: string;
  readonly herdrBin: string;
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly herdrConfigPath: string | undefined;
};

/** Missing or unsafe runtime context. */
export type InvalidPluginEnv = { readonly _tag: "InvalidPluginEnv"; readonly message: string };

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function fallbackHomes(env: NodeJS.ProcessEnv) {
  return {
    config: nonEmpty(env["XDG_CONFIG_HOME"]) ?? nonEmpty(env["APPDATA"]) ?? join(homedir(), ".config"),
    state: nonEmpty(env["XDG_STATE_HOME"]) ?? nonEmpty(env["LOCALAPPDATA"]) ?? join(homedir(), ".local", "state"),
  };
}

function resolveSocketPath(path: string, platform: NodeJS.Platform): string {
  // Windows logical names are opaque: resolving them changes the named pipe identity.
  return platform === "win32" || path.startsWith("\\\\.\\pipe\\") ? path : resolve(path);
}

/** Parse environment once at an entrypoint. Invoking outside Herdr fails closed. */
export function resolvePluginEnv(env: NodeJS.ProcessEnv): Result<PluginEnv, InvalidPluginEnv> {
  const socketPath = nonEmpty(env["HERDR_SOCKET_PATH"]);
  if (socketPath === undefined) return err({ _tag: "InvalidPluginEnv", message: "HERDR_SOCKET_PATH is required; invoke this action through Herdr." });
  const homes = fallbackHomes(env);
  const pluginId = nonEmpty(env["HERDR_PLUGIN_ID"]) ?? PLUGIN_ID;
  const values: PluginEnv = {
    socketPath: resolveSocketPath(socketPath, process.platform),
    herdrBin: nonEmpty(env["HERDR_BIN_PATH"]) ?? "herdr",
    pluginId,
    pluginRoot: resolve(nonEmpty(env["HERDR_PLUGIN_ROOT"]) ?? dirname(dirname(fileURLToPath(import.meta.url)))),
    configDir: resolve(nonEmpty(env["HERDR_PLUGIN_CONFIG_DIR"]) ?? join(homes.config, "herdr", "plugins", "config", pluginId)),
    stateDir: resolve(nonEmpty(env["HERDR_PLUGIN_STATE_DIR"]) ?? join(homes.state, "herdr", "plugins", pluginId)),
    herdrConfigPath: nonEmpty(env["HERDR_CONFIG_PATH"]),
  };
  if (!/^[A-Za-z0-9._:-]+$/u.test(pluginId) || Object.values(values).some((value) => value?.includes("\0"))) {
    return err({ _tag: "InvalidPluginEnv", message: "Invalid plugin identifier or NUL in runtime paths" });
  }
  return ok(values);
}
