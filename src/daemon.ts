import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isHerdrActionId } from "./keymap.ts";
import { stringField, type JsonObject, type JsonValue } from "./json.ts";
import { resolvePluginEnv } from "./plugin-env.ts";
import { pluginPaths, type PluginPaths } from "./plugin-files.ts";
import { serveControl, ensureControlSecret, watcherStatus, type ControlServer } from "./watcher-control.ts";
import { checkLegacyWatcher } from "./watcher-process.ts";
import { createWatcherRuntime, type WatcherRuntime } from "./watcher-runtime.ts";
import { createWatcherLog } from "./watcher-log.ts";
import type { CommandFailed, WatcherCommand } from "./watcher-commands.ts";
import { ok, err, type Result } from "./result.ts";

function notify(phase: "ready" | "failed", message: string): void {
  if (process.send !== undefined && process.connected) process.send({ status: phase, message });
  else (phase === "ready" ? process.stdout : process.stderr).write(`${message}\n`);
  if (phase === "failed") process.exitCode = 1;
}

function rejected(message: string): CommandFailed { return { _tag: "CommandFailed", message }; }

function parseCommand(method: string, args: JsonObject): Result<WatcherCommand, CommandFailed> {
  switch (method) {
    case "pause": case "resume": case "toggle-pause": case "reset": case "refresh-keys": return ok({ type: method });
    case "toggle-mute": {
      const action = stringField(args, "action");
      return action !== undefined && isHerdrActionId(action) ? ok({ type: "toggle-mute", action }) : err(rejected("Unknown action to mute"));
    }
    default: return err(rejected("Unknown watcher command"));
  }
}

type Owner = {
  readonly paths: PluginPaths;
  readonly instance: string;
  phase: "starting" | "ready" | "stopping" | "stopped";
  runtime: WatcherRuntime | undefined;
  server: ControlServer | undefined;
};

function status(owner: Owner): JsonObject {
  const view = owner.runtime?.view();
  const phase = owner.phase === "ready" && view?.["connection"] === "failed" ? "failed" : owner.phase;
  return { ...view, sessionId: owner.paths.sessionId, instance: owner.instance, pid: process.pid, state: phase };
}

async function stop(owner: Owner): Promise<Result<JsonValue, CommandFailed>> {
  if (owner.phase === "stopped") return ok(status(owner));
  if (owner.phase === "stopping") return err(rejected("Watcher is already stopping; wait for shutdown to finish"));
  if (owner.runtime === undefined) return err(rejected("Watcher is still starting; retry shortly"));
  owner.phase = "stopping";
  const result = await owner.runtime.stop();
  if (result._tag === "err") { owner.phase = "ready"; return result; }
  owner.phase = "stopped";
  owner.server?.close();
  return ok(status(owner));
}

async function handle(owner: Owner, method: string, args: JsonObject): Promise<Result<JsonValue, CommandFailed>> {
  if (method === "status") return ok(status(owner));
  if (method === "stop") {
    if (args["instance"] !== owner.instance) return err(rejected("Watcher instance changed; refusing to stop its replacement"));
    return stop(owner);
  }
  if (owner.phase !== "ready" || owner.runtime === undefined) return err(rejected("Watcher is not ready"));
  const command = parseCommand(method, args);
  if (command._tag === "err") return command;
  const result = await owner.runtime.command(command.value);
  return result._tag === "err" ? result : ok({ message: result.value });
}

async function waitForOwner(paths: PluginPaths): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await watcherStatus(paths);
    if (current._tag === "err") { notify("failed", current.error.message); return; }
    if (current.value?.["state"] === "ready") { notify("ready", `Watcher already ready for session ${paths.sessionId}.`); return; }
    await sleep(100);
  }
  notify("failed", `Control port ${paths.controlPort} is occupied but no authenticated watcher became ready. No process was signalled.`);
}

function installSignals(owner: Owner): void {
  const shutdown = () => {
    if (owner.phase === "starting") { owner.server?.close(); process.exit(1); }
    void stop(owner).then((result) => {
      if (result._tag === "err") process.stderr.write(`${result.error.message}\n`);
      return undefined;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
}

async function main(): Promise<void> {
  const env = resolvePluginEnv(process.env);
  if (env._tag === "err") { notify("failed", env.error.message); return; }
  const paths = pluginPaths(env.value);
  const legacy = await checkLegacyWatcher(paths);
  if (legacy._tag === "err") { notify("failed", legacy.error.message); return; }
  const secret = await ensureControlSecret(paths);
  if (secret._tag === "err") { notify("failed", secret.error.message); return; }
  const owner: Owner = { paths, instance: randomUUID(), phase: "starting", runtime: undefined, server: undefined };
  const server = await serveControl(paths, secret.value, (method, args) => handle(owner, method, args));
  if (server._tag === "err") { await waitForOwner(paths); return; }
  owner.server = server.value;
  installSignals(owner);
  const log = createWatcherLog(paths.log);
  const runtime = await createWatcherRuntime(env.value, paths, log);
  if (runtime._tag === "err") { log(runtime.error.message); server.value.close(); notify("failed", runtime.error.message); return; }
  owner.runtime = runtime.value;
  const started = await runtime.value.start();
  if (started._tag === "err") {
    log(started.error.message);
    await runtime.value.stop();
    server.value.close();
    notify("failed", started.error.message);
    return;
  }
  owner.phase = "ready";
  log(`watcher ready for session ${paths.sessionId} (pid ${process.pid})`);
  notify("ready", `Watcher ready for session ${paths.sessionId}.`);
}

void main().catch(() => {
  notify("failed", "Unexpected watcher startup defect; inspect the session log");
  process.exit(1);
});
