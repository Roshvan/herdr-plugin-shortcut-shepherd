import type { HerdrEvent, SessionSnapshot } from "./herdr-event.ts";
import { beginWarmup, resyncSnapshot, observe, settle, takeDroppedCount, takeWarmupDroppedCount, warmupJustEnded, type Detected, type InferenceState } from "./inference.ts";
import { classifyInput, createInputHistory, pruneInput, recordInput, type InputEvent, type InputHistory } from "./input-source.ts";
import type { Keymap } from "./keymap.ts";
import { applyDetection, describeSkip, type Control, type Nudge, type Stats } from "./nudge-policy.ts";
import type { PluginConfig } from "./config.ts";
import { ok, type Result } from "./result.ts";

/** Persistence failure understood by the application rather than a filesystem-specific exception. */
export type StatsSaveFailed = { readonly _tag: "StatsSaveFailed"; readonly message: string };

/** A failed authoritative snapshot refresh; counting must remain in warm-up. */
export type SnapshotRefreshFailed = { readonly _tag: "SnapshotRefreshFailed"; readonly message: string };

/** Application-owned effects; expected persistence/snapshot failures remain values. */
export type ShepherdPorts = {
  readonly showToast: (nudge: Nudge, config: PluginConfig) => Promise<void>;
  readonly saveStats: (stats: Stats) => Promise<Result<void, StatsSaveFailed>>;
  readonly resync: () => Promise<Result<SessionSnapshot, SnapshotRefreshFailed>>;
  readonly log: (message: string) => void;
};

/** Rotate subscriptions periodically, then re-enter the quiet/re-snapshot handshake. */
export const RESYNC_EVERY_MS = 300_000;

/** Parsed initial session state supplied by bootstrap. */
export type ShepherdInitial = {
  readonly stats: Stats;
  readonly config: PluginConfig;
  readonly control: Control;
  readonly keymap: Keymap;
};

/** One session's application state; ticks and saves coalesce overlapping callers. */
export type Shepherd = {
  readonly inference: InferenceState;
  readonly input: InputHistory;
  readonly ports: ShepherdPorts;
  readonly persistEveryMs: number;
  ingestion: "open" | "draining";
  stats: Stats;
  config: PluginConfig;
  control: Control;
  keymap: Keymap;
  dirty: boolean;
  lastPersistAt: number;
  flushing: Promise<Result<void, StatsSaveFailed>> | undefined;
  ticking: Promise<void> | undefined;
};

/** Assemble a session from domain state, explicit effects, and an initial clock reading. */
export function createShepherd(inference: InferenceState, initial: ShepherdInitial, ports: ShepherdPorts, now: number, persistEveryMs = 2000): Shepherd {
  return {
    inference,
    input: createInputHistory(),
    ports,
    persistEveryMs,
    ingestion: "open",
    stats: initial.stats,
    config: initial.config,
    control: initial.control,
    keymap: initial.keymap,
    dirty: false,
    lastPersistAt: now,
    flushing: undefined,
    ticking: undefined,
  };
}

/** Enqueue a parsed lifecycle event for delayed cascade inference until the shutdown cutoff. */
export function observeEvent(shepherd: Shepherd, event: HerdrEvent, now: number): void {
  if (shepherd.ingestion !== "open") return;
  observe(shepherd.inference, event, now);
}

/** Record a local timing estimate before the cutoff; no key contents are accepted. */
export function observeInput(shepherd: Shepherd, event: InputEvent, now: number): void {
  if (shepherd.ingestion !== "open") return;
  recordInput(shepherd.input, event, now);
}

/** Install successfully parsed effective nudge settings without resetting counts. */
export function setConfig(shepherd: Shepherd, config: PluginConfig): void {
  shepherd.config = config;
}

/** Install committed session controls. */
export function setControl(shepherd: Shepherd, control: Control): void {
  shepherd.control = control;
}

/** Install explicitly acknowledged configured bindings. */
export function setKeymap(shepherd: Shepherd, keymap: Keymap): void {
  shepherd.keymap = keymap;
}

/** Replace history with a new revision that must be persisted. */
export function replaceStats(shepherd: Shepherd, stats: Stats): void {
  shepherd.stats = stats;
  shepherd.dirty = true;
}

async function handleDetection(shepherd: Shepherd, detected: Detected, now: number): Promise<void> {
  const { detection } = detected;
  const source = classifyInput(shepherd.input, detected.at);
  const outcome = applyDetection(shepherd.stats, {
    detection,
    source,
    settings: shepherd.config,
    control: shepherd.ingestion === "draining" ? { ...shepherd.control, paused: true } : shepherd.control,
    keymap: shepherd.keymap,
    now,
  });
  shepherd.stats = outcome.stats;
  shepherd.dirty = true;
  if (outcome.nudge !== undefined) {
    shepherd.ports.log(`nudge ${detection.action} [${source}]: ${outcome.nudge.title}`);
    await shepherd.ports.showToast(outcome.nudge, shepherd.config);
  } else if (outcome.skipped !== undefined) {
    shepherd.ports.log(`observed ${detection.action} [${source}] (${describeSkip(outcome.skipped)})`);
  }
}

async function resyncIfDue(shepherd: Shepherd, now: number): Promise<void> {
  if (!warmupJustEnded(shepherd.inference, now)) return;
  const revision = shepherd.inference.warmupRevision;
  shepherd.ports.log("event stream quiet; resyncing from session.snapshot before counting");
  const snapshot = await shepherd.ports.resync();
  if (shepherd.ingestion !== "open" || revision !== shepherd.inference.warmupRevision) return;
  if (snapshot._tag === "err") {
    shepherd.ports.log(`snapshot refresh failed; counting suspended: ${snapshot.error.message}`);
    beginWarmup(shepherd.inference, now);
    return;
  }
  resyncSnapshot(shepherd.inference, snapshot.value);
}

function logDrops(shepherd: Shepherd): void {
  const replayed = takeWarmupDroppedCount(shepherd.inference);
  if (replayed > 0) shepherd.ports.log(`ignored ${replayed} detection(s) during warm-up`);
  const dropped = takeDroppedCount(shepherd.inference);
  if (dropped > 0) shepherd.ports.log(`dropped ${dropped} detection(s) as automation (too fast for a person)`);
}

async function tickOnce(shepherd: Shepherd, now: number): Promise<void> {
  if (shepherd.ingestion !== "open") return;
  pruneInput(shepherd.input, now);
  await resyncIfDue(shepherd, now);
  if (shepherd.ingestion !== "open") return;
  for (const detected of settle(shepherd.inference, now)) await handleDetection(shepherd, detected, now);
  logDrops(shepherd);
  if (shepherd.dirty && now - shepherd.lastPersistAt >= shepherd.persistEveryMs) await flushShepherd(shepherd, now);
}

/** Close ingestion synchronously, preserving accepted history and suppressing subsequent nudges. */
export function beginShepherdShutdown(shepherd: Shepherd): void {
  shepherd.ingestion = "draining";
}

/** Settle mature accepted events under the owner's serial queue, without resnapshotting, input pruning, or nudges. */
export async function settleShepherdShutdown(shepherd: Shepherd, now: number): Promise<void> {
  beginShepherdShutdown(shepherd);
  for (const detected of settle(shepherd.inference, now)) await handleDetection(shepherd, detected, now);
  logDrops(shepherd);
}

/** Run at most one tick at a time, even when effects outlast the timer interval. */
export async function tickShepherd(shepherd: Shepherd, now: number): Promise<void> {
  if (shepherd.ticking !== undefined) return shepherd.ticking;
  shepherd.ticking = tickOnce(shepherd, now);
  try {
    await shepherd.ticking;
  } finally {
    shepherd.ticking = undefined;
  }
}

/** Persist one coherent revision. Failed saves stay dirty; newer revisions cannot be marked saved. */
export async function flushShepherd(shepherd: Shepherd, now: number): Promise<Result<void, StatsSaveFailed>> {
  if (shepherd.flushing !== undefined) {
    const saved = await shepherd.flushing;
    return saved._tag === "err" ? saved : flushShepherd(shepherd, now);
  }
  if (!shepherd.dirty) return ok(undefined);
  const snapshot = shepherd.stats;
  shepherd.lastPersistAt = now;
  shepherd.flushing = shepherd.ports.saveStats(snapshot);
  try {
    const saved = await shepherd.flushing;
    if (saved._tag === "ok" && shepherd.stats === snapshot) shepherd.dirty = false;
    if (saved._tag === "err") shepherd.ports.log(`stats save failed: ${saved.error.message}`);
    return saved;
  } finally {
    shepherd.flushing = undefined;
  }
}
