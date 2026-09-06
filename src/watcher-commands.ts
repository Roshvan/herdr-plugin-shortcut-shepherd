import type { HerdrActionId } from "./keymap.ts";
import { emptyStats, type Control } from "./nudge-policy.ts";
import { flushShepherd, replaceStats, setControl, type Shepherd } from "./shepherd.ts";
import { err, ok, type Result } from "./result.ts";

/** Parsed user intent; all mutations run through the session's single-writer queue. */
export type WatcherCommand =
  | { readonly type: "pause" | "resume" | "toggle-pause" | "reset" | "refresh-keys" }
  | { readonly type: "toggle-mute"; readonly action: HerdrActionId };

/** A command was not committed; callers must surface the reason instead of claiming success. */
export type CommandFailed = { readonly _tag: "CommandFailed"; readonly message: string };

/** Application-owned effects needed by session control operations. */
export type CommandPorts = {
  readonly saveControl: (control: Control) => Promise<Result<void, CommandFailed>>;
  readonly refreshKeys: () => Promise<Result<void, CommandFailed>>;
  readonly now: () => number;
};

async function reset(shepherd: Shepherd, now: number): Promise<Result<string, CommandFailed>> {
  const previous = shepherd.stats;
  const wasDirty = shepherd.dirty;
  replaceStats(shepherd, emptyStats(now));
  const saved = await flushShepherd(shepherd, now);
  if (saved._tag === "err") {
    replaceStats(shepherd, previous);
    shepherd.dirty = wasDirty;
    return err({ _tag: "CommandFailed", message: saved.error.message });
  }
  return ok("Statistics reset for this session.");
}

function nextControl(shepherd: Shepherd, command: Exclude<WatcherCommand, { readonly type: "reset" }>): Control {
  const current = shepherd.control;
  if (command.type === "toggle-mute") {
    const muted = new Set(current.muted);
    if (muted.has(command.action)) muted.delete(command.action);
    else muted.add(command.action);
    return { ...current, muted };
  }
  const paused = command.type === "toggle-pause" ? !current.paused : command.type === "pause";
  return { ...current, paused };
}

/** Commit pause/mute/reset changes through application ports; publish in-memory state only after success. */
export async function executeWatcherCommand(shepherd: Shepherd, command: WatcherCommand, ports: CommandPorts): Promise<Result<string, CommandFailed>> {
  if (command.type === "reset") return reset(shepherd, ports.now());
  if (command.type === "refresh-keys") {
    const refreshed = await ports.refreshKeys();
    return refreshed._tag === "err" ? refreshed : ok("Configured shortcuts refreshed. Herdr config must already have been reloaded.");
  }
  if (command.type === "toggle-mute" && shepherd.config.suppressed.has(command.action)) {
    return err({ _tag: "CommandFailed", message: "This action is suppressed in shared config.json; edit that file to unmute it." });
  }
  const control = nextControl(shepherd, command);
  const saved = await ports.saveControl(control);
  if (saved._tag === "err") return saved;
  setControl(shepherd, control);
  return ok(command.type === "toggle-mute" ? "Session mute setting saved." : control.paused ? "Nudges paused; counting continues." : "Nudges resumed for this session.");
}
