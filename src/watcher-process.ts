import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isJsonObject, stringField, type JsonValue } from "./json.ts";
import type { PluginEnv } from "./plugin-env.ts";
import type { PluginPaths } from "./plugin-files.ts";
import { callWatcher, readControlSecret, watcherStatus, type WatcherUnavailable } from "./watcher-control.ts";
import { ok, err, type Result } from "./result.ts";

/** Refuse automatic migration of a bare legacy PID lock; never signal its contents. */
export async function checkLegacyWatcher(paths: PluginPaths): Promise<Result<void, WatcherUnavailable>> {
  try {
    await lstat(paths.legacyLock);
    return err({ _tag: "WatcherUnavailable", code: "LEGACY_WATCHER", message: `Legacy watcher lock exists at ${paths.legacyLock}. Verify the old watcher is stopped, then move that lock aside. No PID was signalled.` });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return ok(undefined);
    return err({ _tag: "WatcherUnavailable", code: "LEGACY_UNREADABLE", message: `Cannot inspect ${paths.legacyLock}` });
  }
}

function startChild(env: PluginEnv, inherited: NodeJS.ProcessEnv): Promise<Result<string, WatcherUnavailable>> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(env.pluginRoot, "src", "daemon.ts")], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      env: { ...inherited, HERDR_SOCKET_PATH: env.socketPath, HERDR_PLUGIN_STATE_DIR: env.stateDir, HERDR_PLUGIN_CONFIG_DIR: env.configDir },
    });
    let settled = false;
    const finish = (result: Result<string, WatcherUnavailable>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      resolve(result);
    };
    const fail = (message: string) => finish(err({ _tag: "WatcherUnavailable", code: "START_FAILED", message }));
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail("Watcher startup timed out; inspect its session log"); }, 15000);
    child.on("message", (message: JsonValue) => {
      if (!isJsonObject(message)) return;
      const detail = stringField(message, "message") ?? "Watcher startup failed";
      if (message["status"] === "ready") finish(ok(detail));
      else if (message["status"] === "failed") fail(detail);
    });
    child.once("error", () => fail("Could not spawn the watcher process"));
    child.once("exit", (code) => fail(`Watcher exited before readiness (code ${code}); inspect its session log`));
  });
}

/** Ensure exactly one ready watcher in this session; detached spawn alone is not success. */
export async function startWatcher(env: PluginEnv, paths: PluginPaths, inherited: NodeJS.ProcessEnv): Promise<Result<string, WatcherUnavailable>> {
  const legacy = await checkLegacyWatcher(paths);
  if (legacy._tag === "err") return legacy;
  const status = await watcherStatus(paths);
  if (status._tag === "err") return status;
  if (status.value?.["state"] === "ready") return ok(`Watcher ready for session ${paths.sessionId}.`);
  return startChild(env, inherited);
}

async function waitForRelease(paths: PluginPaths, instance: string): Promise<Result<string, WatcherUnavailable>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await watcherStatus(paths);
    if (current._tag === "err") return current;
    if (current.value === undefined || current.value["instance"] !== instance) return ok("Watcher stopped; statistics saved.");
    await sleep(50);
  }
  return err({ _tag: "WatcherUnavailable", code: "STOP_TIMEOUT", message: "Watcher acknowledged stop but has not released its endpoint" });
}

/** Stop only an authenticated instance and wait until that instance releases its endpoint. */
export async function stopWatcher(paths: PluginPaths): Promise<Result<string, WatcherUnavailable>> {
  const status = await watcherStatus(paths);
  if (status._tag === "err") return status;
  if (status.value === undefined) {
    const legacy = await checkLegacyWatcher(paths);
    return legacy._tag === "err" ? legacy : ok("Watcher is not running in this session.");
  }
  const instance = stringField(status.value, "instance");
  if (instance === undefined) return err({ _tag: "WatcherUnavailable", code: "IDENTITY_MISMATCH", message: "Watcher did not provide an instance identity" });
  const secret = await readControlSecret(paths);
  if (secret._tag === "err") return secret;
  if (secret.value === undefined) return err({ _tag: "WatcherUnavailable", code: "SECRET_MISSING", message: "Control key disappeared; refusing to stop any process" });
  const stopped = await callWatcher(paths, secret.value, "stop", { instance });
  return stopped._tag === "err" ? stopped : waitForRelease(paths, instance);
}
