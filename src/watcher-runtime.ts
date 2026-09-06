import { setTimeout as sleep } from "node:timers/promises";
import { configToJson, type PluginConfig } from "./config.ts";
import { parseHerdrEventLine, parseSessionSnapshot, SUBSCRIBED_EVENT_NAMES } from "./herdr-event.ts";
import { showToast } from "./herdr-cli.ts";
import { loadKeymap, locateHerdrConfig, type LoadedKeymap } from "./herdr-config.ts";
import { openEventStream, requestOnce, type SocketLines } from "./herdr-socket.ts";
import { beginWarmup, createInference, installSnapshot, nextSettlementAt } from "./inference.ts";
import { startInputMonitor, type InputMonitor } from "./input-monitor.ts";
import { controlToJson, statsToJson } from "./nudge-policy.ts";
import type { PluginEnv } from "./plugin-env.ts";
import { loadControl, loadConfig, loadStats, saveControl, saveStats, seedConfigFromExample, type PluginPaths } from "./plugin-files.ts";
import { RESYNC_EVERY_MS, beginShepherdShutdown, createShepherd, flushShepherd, observeEvent, observeInput, setConfig, setKeymap, settleShepherdShutdown, tickShepherd, type Shepherd } from "./shepherd.ts";
import { createSerialExecutor, type SerialExecutor } from "./serial.ts";
import { executeWatcherCommand, type CommandFailed, type WatcherCommand } from "./watcher-commands.ts";
import { ok, err, type Result } from "./result.ts";
import type { JsonObject } from "./json.ts";

export type WatcherRuntime = {
  readonly start: () => Promise<Result<void, CommandFailed>>;
  readonly stop: () => Promise<Result<void, CommandFailed>>;
  readonly command: (command: WatcherCommand) => Promise<Result<string, CommandFailed>>;
  readonly view: () => JsonObject;
};

type State = {
  readonly env: PluginEnv;
  readonly paths: PluginPaths;
  readonly herdrConfig: string;
  readonly log: (message: string) => void;
  readonly abort: AbortController;
  readonly queue: SerialExecutor;
  readonly shepherd: Shepherd;
  settings: PluginConfig;
  keymap: LoadedKeymap;
  keymapWarning: string | undefined;
  configWarning: string | undefined;
  inputMode: "off" | "local-estimate" | "unavailable";
  monitor: InputMonitor | undefined;
  connection: "connected" | "reconnecting" | "stopped";
  startTask: Promise<Result<void, CommandFailed>> | undefined;
  streamTask: Promise<void> | undefined;
  timer: ReturnType<typeof setInterval> | undefined;
  tickPending: boolean;
  lastPollAt: number;
  shutdown: { readonly phase: "open" } | { readonly phase: "draining"; readonly cleanup: Promise<void> } | { readonly phase: "stopped" };
};

function commandFailed(message: string): CommandFailed { return { _tag: "CommandFailed", message }; }

function applySettings(state: State): void {
  setConfig(state.shepherd, { ...state.settings, enabled: state.settings.enabled && state.keymapWarning === undefined });
}

async function replaceMonitor(state: State): Promise<void> {
  await state.monitor?.stop();
  if (state.abort.signal.aborted) return;
  state.monitor = undefined;
  state.shepherd.input.events = [];
  state.inputMode = "off";
  if (state.settings.inputMonitoring === "off") return;
  state.inputMode = "unavailable";
  const monitor = startInputMonitor(process.platform, {
    onEvent: (event) => observeInput(state.shepherd, event, Date.now()),
    onExit: (detail) => {
      if (state.monitor === monitor && !state.abort.signal.aborted) {
        state.log(`input monitor exited: ${detail}; subsequent input is unknown`);
        state.shepherd.input.events = [];
        state.monitor = undefined;
        state.inputMode = "unavailable";
      }
    },
  });
  state.monitor = monitor;
  if (monitor !== undefined) state.inputMode = "local-estimate";
  state.log(`input mode: ${state.inputMode}; local timing is not verified shortcut use`);
}

async function checkKeys(state: State): Promise<void> {
  const loaded = await loadKeymap(state.herdrConfig);
  const warning = loaded._tag === "err" ? loaded.error.message : loaded.value.fingerprint === state.keymap.fingerprint
    ? undefined : "Bindings changed on disk. Reload Herdr config, then invoke refresh-keys (or press b). Nudges are suspended.";
  if (warning !== state.keymapWarning && warning !== undefined) state.log(warning);
  state.keymapWarning = warning;
}

async function pollSettings(state: State, now: number): Promise<void> {
  if (now - state.lastPollAt < 1500) return;
  state.lastPollAt = now;
  const settings = await loadConfig(state.paths);
  const warning = settings._tag === "err" ? settings.error.message : undefined;
  if (warning !== state.configWarning && warning !== undefined) state.log(warning);
  state.configWarning = warning;
  if (settings._tag === "ok") {
    const previousMode = state.settings.inputMonitoring;
    state.settings = settings.value;
    if (previousMode !== state.settings.inputMonitoring) await replaceMonitor(state);
  }
  await checkKeys(state);
  applySettings(state);
}

async function refreshKeys(state: State): Promise<Result<void, CommandFailed>> {
  const loaded = await loadKeymap(state.herdrConfig);
  if (loaded._tag === "err") return err(commandFailed(loaded.error.message));
  state.keymap = loaded.value;
  state.keymapWarning = undefined;
  setKeymap(state.shepherd, loaded.value.keymap);
  applySettings(state);
  state.log("configured bindings refreshed by explicit user acknowledgment");
  return ok(undefined);
}

async function connectStream(state: State): Promise<Result<SocketLines, CommandFailed>> {
  const options = { signal: state.abort.signal };
  const stream = await openEventStream(state.env.socketPath, SUBSCRIBED_EVENT_NAMES, options);
  if (stream._tag === "err") return err(commandFailed(stream.error.message));
  const snapshot = await requestOnce(state.env.socketPath, "session.snapshot", {}, options);
  const parsed = snapshot._tag === "ok" ? parseSessionSnapshot(snapshot.value) : snapshot;
  if (parsed._tag === "err") { stream.value.close(); return err(commandFailed(parsed.error.message)); }
  if (state.abort.signal.aborted) { stream.value.close(); return err(commandFailed("Watcher ingestion has stopped")); }
  installSnapshot(state.shepherd.inference, parsed.value, Date.now());
  state.connection = "connected";
  state.log("connected; warming up retained event history");
  return ok(stream.value);
}

async function consumeStream(state: State, stream: SocketLines): Promise<void> {
  const lease = setTimeout(stream.close, RESYNC_EVERY_MS);
  try {
    while (!state.abort.signal.aborted) {
      const line = await stream.next();
      if (state.abort.signal.aborted) return;
      if (line._tag === "err") { state.log(line.error.message); return; }
      if (line.value === undefined) return;
      const event = parseHerdrEventLine(line.value);
      if (event._tag === "ok") observeEvent(state.shepherd, event.value, Date.now());
      else if (event.error._tag === "MalformedHerdrEvent") state.log(event.error.message);
    }
  } finally {
    clearTimeout(lease);
    stream.close();
    state.connection = "reconnecting";
    if (!state.abort.signal.aborted) beginWarmup(state.shepherd.inference, Date.now());
  }
}

async function runStreams(state: State, first: SocketLines): Promise<void> {
  await consumeStream(state, first);
  let attempt = 0;
  while (!state.abort.signal.aborted) {
    state.connection = "reconnecting";
    const delay = [1000, 2000, 5000, 10000, 20000][Math.min(attempt, 4)] ?? 20000;
    await sleep(delay, undefined, { signal: state.abort.signal }).catch(() => undefined);
    if (state.abort.signal.aborted) return;
    const stream = await connectStream(state);
    if (stream._tag === "err") { state.log(`reconnect failed: ${stream.error.message}`); attempt += 1; continue; }
    attempt = 0;
    await consumeStream(state, stream.value);
  }
}

function scheduleTicks(state: State): void {
  state.timer = setInterval(() => {
    if (state.tickPending || state.abort.signal.aborted) return;
    state.tickPending = true;
    void state.queue.run(async () => {
      if (state.abort.signal.aborted) return;
      const now = Date.now();
      await pollSettings(state, now);
      if (state.abort.signal.aborted) return;
      await tickShepherd(state.shepherd, now);
    }).catch(() => {
      state.log("unexpected tick defect; shutting down owned resources");
      state.abort.abort();
      clearInterval(state.timer);
      void state.monitor?.stop();
      process.exitCode = 1;
    }).finally(() => { state.tickPending = false; });
  }, 250);
}

function cutoff(state: State): void {
  if (state.shutdown.phase !== "open") return;
  beginShepherdShutdown(state.shepherd);
  state.abort.abort();
  clearInterval(state.timer);
  const cleanup = Promise.all([state.monitor?.stop(), state.streamTask, state.startTask]).then(() => undefined);
  state.shutdown = { phase: "draining", cleanup };
}

async function stop(state: State): Promise<Result<void, CommandFailed>> {
  if (state.shutdown.phase === "stopped") return ok(undefined);
  if (state.shutdown.phase !== "draining") return err(commandFailed("Shutdown requires an ingestion cutoff"));
  let due = nextSettlementAt(state.shepherd.inference);
  while (due !== undefined) {
    await sleep(Math.max(0, due - Date.now()));
    await settleShepherdShutdown(state.shepherd, Date.now());
    due = nextSettlementAt(state.shepherd.inference);
  }
  await state.shutdown.cleanup;
  const saved = await flushShepherd(state.shepherd, Date.now());
  if (saved._tag === "err") return err(commandFailed(`Ingestion stopped; pending statistics retained. Retry stop to save: ${saved.error.message}`));
  state.shepherd.input.events = [];
  state.monitor = undefined;
  state.inputMode = "off";
  state.connection = "stopped";
  state.shutdown = { phase: "stopped" };
  state.log("watcher stopped; statistics saved");
  return ok(undefined);
}

async function start(state: State): Promise<Result<void, CommandFailed>> {
  const stream = await connectStream(state);
  if (stream._tag === "err") return stream;
  await replaceMonitor(state);
  if (state.abort.signal.aborted) { stream.value.close(); return err(commandFailed("Watcher startup was cancelled")); }
  state.streamTask = runStreams(state, stream.value);
  scheduleTicks(state);
  return ok(undefined);
}

function exposeRuntime(state: State): WatcherRuntime {
  return {
    start: () => { state.startTask ??= start(state); return state.startTask; },
    stop: () => { cutoff(state); return state.queue.run(() => stop(state)); },
    command: (command) => state.queue.run(() => state.abort.signal.aborted ? Promise.resolve(err(commandFailed("Watcher has stopped"))) : executeWatcherCommand(state.shepherd, command, {
      saveControl: async (control) => {
        const result = await saveControl(state.paths, control);
        return result._tag === "err" ? err(commandFailed(result.error.message)) : result;
      },
      refreshKeys: () => refreshKeys(state),
      now: Date.now,
    })),
    view: () => ({
      connection: connectionView(state), counting: countingView(state),
      inputMode: state.inputMode, keymapWarning: state.keymapWarning ?? null, configWarning: state.configWarning ?? null,
      config: configToJson(state.settings), control: controlToJson(state.shepherd.control), stats: statsToJson(state.shepherd.stats),
      keymap: { prefix: state.keymap.keymap.prefix, bindings: Object.fromEntries(state.keymap.keymap.bindings) },
    }),
  };
}

function connectionView(state: State): string {
  if (state.shutdown.phase !== "open") return state.shutdown.phase;
  return state.abort.signal.aborted ? "failed" : state.connection;
}

function countingView(state: State): string {
  if (connectionView(state) !== "connected") return "suspended";
  return state.shepherd.inference.warmedUp ? "active" : "warming-up";
}

export async function createWatcherRuntime(env: PluginEnv, paths: PluginPaths, log: (message: string) => void): Promise<Result<WatcherRuntime, CommandFailed>> {
  const seeded = await seedConfigFromExample(paths, env.pluginRoot);
  if (seeded._tag === "err") return err(commandFailed(seeded.error.message));
  const now = Date.now();
  const settings = await loadConfig(paths);
  if (settings._tag === "err") return err(commandFailed(settings.error.message));
  const control = await loadControl(paths);
  if (control._tag === "err") return err(commandFailed(control.error.message));
  const stats = await loadStats(paths, now);
  if (stats._tag === "err") return err(commandFailed(`${stats.error.message}; original stats file preserved`));
  const herdrConfig = locateHerdrConfig(env.herdrConfigPath, process.platform, process.env);
  const keymap = await loadKeymap(herdrConfig);
  if (keymap._tag === "err") return err(commandFailed(keymap.error.message));
  const abort = new AbortController();
  const inference = createInference();
  const shepherd = createShepherd(inference, { stats: stats.value, control: control.value, config: settings.value, keymap: keymap.value.keymap }, {
    showToast: async (nudge, config) => {
      const result = await showToast(env.herdrBin, nudge, config, abort.signal);
      if (result._tag === "err") log(result.error.message);
    },
    saveStats: async (current) => {
      const result = await saveStats(paths, current);
      return result._tag === "err" ? err({ _tag: "StatsSaveFailed" as const, message: result.error.message }) : result;
    },
    resync: async () => {
      const response = await requestOnce(env.socketPath, "session.snapshot", {}, { signal: abort.signal });
      const parsed = response._tag === "ok" ? parseSessionSnapshot(response.value) : response;
      return parsed._tag === "err" ? err({ _tag: "SnapshotRefreshFailed" as const, message: parsed.error.message }) : parsed;
    },
    log,
  }, now);
  return ok(exposeRuntime({ env, paths, herdrConfig, log, abort, queue: createSerialExecutor(), shepherd,
    settings: settings.value, keymap: keymap.value, keymapWarning: undefined, configWarning: undefined,
    inputMode: "off", monitor: undefined, connection: "reconnecting", startTask: undefined, streamTask: undefined,
    timer: undefined, tickPending: false, lastPollAt: now, shutdown: { phase: "open" },
  }));
}
