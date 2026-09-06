import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isJsonObject, stringField, type JsonObject, type JsonValue } from "./json.ts";
import type { PluginEnv } from "./plugin-env.ts";
import type { PluginPaths } from "./plugin-files.ts";
import { callWatcher, readControlSecret, watcherStatus, type WatcherUnavailable } from "./watcher-control.ts";
import { ok, err, type Result } from "./result.ts";

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

function isReady(status: JsonObject | undefined): boolean {
  return status?.["state"] === "ready" && status["connection"] === "connected";
}

async function statusBefore(paths: PluginPaths, deadline: number): Promise<Result<JsonObject | undefined, WatcherUnavailable>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result<JsonObject | undefined, WatcherUnavailable>>((resolve) => {
    timer = setTimeout(() => resolve(err({ _tag: "WatcherUnavailable", code: "STATUS_TIMEOUT", message: "Authenticated watcher status deadline exceeded" })), Math.max(0, deadline - performance.now()));
  });
  // The adapter's own deadline still bounds an in-flight read after this caller times out.
  try { return await Promise.race([watcherStatus(paths), timeout]); }
  finally { clearTimeout(timer); }
}

/** Wait at most ten seconds for authenticated subscription/snapshot readiness; never spawn a contender. */
export async function waitForWatcherReady(paths: PluginPaths): Promise<Result<string, WatcherUnavailable>> {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const status = await statusBefore(paths, deadline);
    if (status._tag === "err") return status;
    if (isReady(status.value)) return ok(`Watcher ready for session ${paths.sessionId}.`);
    const phase = status.value?.["state"];
    if (phase === "failed" || phase === "stop-failed" || phase === "stopping" || phase === "stopped") {
      return err({ _tag: "WatcherUnavailable", code: "OWNER_NOT_READY", message: `Authenticated watcher is ${phase}; resolve shutdown before starting again` });
    }
    await sleep(Math.min(100, Math.max(0, deadline - performance.now())));
  }
  return err({ _tag: "WatcherUnavailable", code: "READY_TIMEOUT", message: "No authenticated watcher became ready before the deadline; an existing owner was left in place. Retry start after it reconnects." });
}

/** Spawn only when no authenticated owner exists; an existing owner's readiness must be awaited. */
export async function startWatcher(env: PluginEnv, paths: PluginPaths, inherited: NodeJS.ProcessEnv): Promise<Result<string, WatcherUnavailable>> {
  const status = await statusBefore(paths, performance.now() + 10000);
  if (status._tag === "err") return status;
  if (isReady(status.value)) return ok(`Watcher ready for session ${paths.sessionId}.`);
  if (status.value !== undefined) return waitForWatcherReady(paths);
  return startChild(env, inherited);
}

async function waitForRelease(paths: PluginPaths, instance: string): Promise<Result<string, WatcherUnavailable>> {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const current = await statusBefore(paths, deadline);
    if (current._tag === "err") return current;
    if (current.value === undefined || current.value["instance"] !== instance) return ok("Watcher stopped; statistics saved.");
    await sleep(50);
  }
  return err({ _tag: "WatcherUnavailable", code: "STOP_TIMEOUT", message: "Watcher acknowledged stop but has not released its endpoint" });
}

/** Stop only an authenticated instance and wait until that instance releases its endpoint. */
export async function stopWatcher(paths: PluginPaths): Promise<Result<string, WatcherUnavailable>> {
  const status = await statusBefore(paths, performance.now() + 10000);
  if (status._tag === "err") return status;
  if (status.value === undefined) return ok("Watcher is not running in this session.");
  const instance = stringField(status.value, "instance");
  if (instance === undefined) return err({ _tag: "WatcherUnavailable", code: "IDENTITY_MISMATCH", message: "Watcher did not provide an instance identity" });
  const secret = await readControlSecret(paths);
  if (secret._tag === "err") return secret;
  if (secret.value === undefined) return err({ _tag: "WatcherUnavailable", code: "SECRET_MISSING", message: "Control key disappeared; refusing to stop any process" });
  const stopped = await callWatcher(paths, secret.value, "stop", { instance });
  return stopped._tag === "err" ? stopped : waitForRelease(paths, instance);
}
