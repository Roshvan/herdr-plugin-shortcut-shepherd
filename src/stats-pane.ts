import { emitKeypressEvents, type Key } from "node:readline";
import { actionContext, ensureWatcher, fail } from "./actions/watcher.ts";
import { callWatcher, readControlSecret, watcherStatus, type ControlSecret } from "./watcher-control.ts";
import { parseStatsView, renderStatsView, viewRows, type StatsUi, type StatsView } from "./stats-view.ts";
import { createSerialExecutor } from "./serial.ts";
import { isJsonObject, stringField, type JsonObject } from "./json.ts";
import type { PluginPaths } from "./plugin-files.ts";
import { err, ok, type Result } from "./result.ts";

type Session = { readonly paths: PluginPaths; readonly secret: ControlSecret; readonly ui: StatsUi; view: StatsView };
type ViewFailed = { readonly message: string; readonly _tag: "ViewFailed" };

async function loadView(paths: PluginPaths): Promise<Result<StatsView, ViewFailed>> {
  const status = await watcherStatus(paths);
  if (status._tag === "err") return err({ _tag: "ViewFailed", message: status.error.message });
  if (status.value === undefined) return err({ _tag: "ViewFailed", message: "Watcher stopped. Close this popup and run the start action." });
  const view = parseStatsView(status.value, Date.now());
  return view._tag === "err" ? err({ _tag: "ViewFailed", message: view.error.message }) : ok(view.value);
}

async function command(session: Session, method: string, args: JsonObject = {}): Promise<void> {
  const result = await callWatcher(session.paths, session.secret, method, args);
  session.ui.message = result._tag === "err" ? result.error.message : isJsonObject(result.value) ? stringField(result.value, "message") ?? "Saved." : "Saved.";
}

const CURSOR_DELTAS: ReadonlyMap<string, number> = new Map([["j", 1], ["down", 1], ["k", -1], ["up", -1]]);

async function handleKey(session: Session, key: string): Promise<void> {
  if (session.ui.confirmReset) {
    session.ui.confirmReset = false;
    if (key === "y" || key === "Y") await command(session, "reset");
    return;
  }
  const delta = CURSOR_DELTAS.get(key);
  if (delta !== undefined) { session.ui.cursor += delta; return; }
  switch (key) {
    case "r": session.ui.confirmReset = true; return;
    case "p": await command(session, "toggle-pause"); return;
    case "b": await command(session, "refresh-keys"); return;
    case "s": {
      const row = viewRows(session.view)[session.ui.cursor];
      if (row !== undefined) await command(session, "toggle-mute", { action: row.id });
      return;
    }
    default: return;
  }
}

function runUi(session: Session): void {
  const queue = createSerialExecutor();
  let closed = false;
  let refreshPending = false;
  const draw = () => {
    if (closed) return;
    session.ui.cursor = Math.max(0, Math.min(session.ui.cursor, viewRows(session.view).length - 1));
    process.stdout.write(renderStatsView(session.view, session.ui, process.stdout.columns ?? 100, process.stdout.rows ?? 30));
  };
  const refresh = async () => {
    const selected = viewRows(session.view)[session.ui.cursor]?.id;
    const view = await loadView(session.paths);
    if (view._tag === "ok") {
      session.view = view.value;
      const index = viewRows(view.value).findIndex((row) => row.id === selected);
      if (index >= 0) session.ui.cursor = index;
    } else session.ui.message = view.error.message;
    draw();
  };
  const timer = setInterval(() => {
    if (refreshPending || closed) return;
    refreshPending = true;
    void queue.run(refresh).finally(() => { refreshPending = false; });
  }, 1000);
  const quit = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\u001b[?25h\u001b[0m\n");
    process.exit(0);
  };
  process.stdout.write("\u001b[?25l");
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", (text: string | undefined, key: Key) => {
    const name = key.name ?? text ?? "";
    if (name === "q" || name === "escape" || (key.ctrl && name === "c")) { quit(); return; }
    void queue.run(async () => { if (!closed) { await handleKey(session, text === "Y" ? "Y" : name); await refresh(); } });
  });
  process.stdin.on("end", quit);
  process.stdout.on("resize", draw);
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  draw();
}

async function main(): Promise<void> {
  const context = actionContext();
  await ensureWatcher(context);
  const secret = await readControlSecret(context.paths);
  if (secret._tag === "err") fail(secret.error.message);
  if (secret.value === undefined) fail("Watcher control key disappeared");
  const view = await loadView(context.paths);
  if (view._tag === "err") fail(view.error.message);
  runUi({ paths: context.paths, secret: secret.value, view: view.value, ui: { cursor: 0, confirmReset: false, message: "" } });
}

void main();
