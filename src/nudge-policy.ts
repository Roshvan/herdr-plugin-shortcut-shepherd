import { err, ok, type Result } from "./result.ts";
import { actionSpec, bindingsFor, formatBinding, isHerdrActionId, type HerdrActionId, type Keymap } from "./keymap.ts";
import type { PluginConfig } from "./config.ts";
import { isBoolean, isFiniteNumber, isJsonArray, isJsonObject, isString, type JsonObject, type JsonValue } from "./json.ts";
import type { InputSource } from "./input-source.ts";

type ActionStats = {
  readonly count: number;
  readonly hits: number;
  readonly unknown: number;
  readonly nudges: number;
  readonly lastSeenAt: number;
  readonly lastNudgedAt: number | undefined;
};

export type Stats = {
  readonly since: number;
  readonly actions: ReadonlyMap<HerdrActionId, ActionStats>;
  readonly recentNudges: ReadonlyArray<number>;
};

export type Control = {
  readonly paused: boolean;
  readonly muted: ReadonlySet<HerdrActionId>;
};

const DEFAULT_CONTROL: Control = { paused: false, muted: new Set() };

export function emptyStats(now: number): Stats {
  return { since: now, actions: new Map(), recentNudges: [] };
}

type StateFile = "stats" | "control";

export type InvalidStateFile = { readonly _tag: "InvalidStateFile"; readonly message: string; readonly file: StateFile; readonly field: string };

function invalidStateFile(file: StateFile, field: string): InvalidStateFile {
  return { _tag: "InvalidStateFile", message: `${file}.json field ${field} is invalid`, file, field };
}

type Counters = { readonly count: number; readonly hits: number; readonly unknown: number; readonly nudges: number; readonly lastSeenAt: number };

function nonnegativeInteger(value: JsonValue | undefined): number | undefined {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseCounters(value: JsonObject): Counters | undefined {
  const count = nonnegativeInteger(value["count"]);
  const hits = nonnegativeInteger(value["hits"]);
  const unknown = nonnegativeInteger(value["unknown"]);
  const nudges = nonnegativeInteger(value["nudges"]);
  const lastSeenAt = nonnegativeInteger(value["lastSeenAt"]);
  if (count === undefined || hits === undefined || unknown === undefined || nudges === undefined || lastSeenAt === undefined) return undefined;
  return { count, hits, unknown, nudges, lastSeenAt };
}

function parseActionStats(value: JsonValue): ActionStats | undefined {
  if (!isJsonObject(value)) return undefined;
  const counters = parseCounters(value);
  const rawLastNudgedAt = value["lastNudgedAt"];
  const lastNudgedAt = nonnegativeInteger(rawLastNudgedAt);
  if (counters === undefined || (rawLastNudgedAt !== null && lastNudgedAt === undefined)) return undefined;
  return { ...counters, lastNudgedAt };
}

function parseActionsMap(value: JsonValue | undefined): Result<ReadonlyMap<HerdrActionId, ActionStats>, InvalidStateFile> {
  if (!isJsonObject(value)) return err(invalidStateFile("stats", "actions"));
  const actions = new Map<HerdrActionId, ActionStats>();
  for (const [id, raw] of Object.entries(value)) {
    if (!isHerdrActionId(id)) continue;
    const parsed = parseActionStats(raw);
    if (parsed === undefined) return err(invalidStateFile("stats", `actions.${id}`));
    actions.set(id, parsed);
  }
  return ok(actions);
}

function parseRecentNudges(value: JsonValue | undefined): Result<ReadonlyArray<number>, InvalidStateFile> {
  if (!isJsonArray(value)) return err(invalidStateFile("stats", "recentNudges"));
  const out: number[] = [];
  for (const item of value) {
    const stamp = nonnegativeInteger(item);
    if (stamp === undefined) return err(invalidStateFile("stats", "recentNudges"));
    out.push(stamp);
  }
  return ok(out);
}

export function parseStats(value: JsonValue | undefined, now: number): Result<Stats, InvalidStateFile> {
  if (value === undefined) return ok(emptyStats(now));
  if (!isJsonObject(value)) return err(invalidStateFile("stats", "root"));
  const since = nonnegativeInteger(value["since"]);
  if (since === undefined) return err(invalidStateFile("stats", "since"));
  const actions = parseActionsMap(value["actions"]);
  if (actions._tag === "err") return actions;
  const recentNudges = parseRecentNudges(value["recentNudges"]);
  if (recentNudges._tag === "err") return recentNudges;
  return ok({ since, actions: actions.value, recentNudges: recentNudges.value });
}

export function statsToJson(stats: Stats) {
  return {
    since: stats.since,
    actions: Object.fromEntries(
      stats.actions.entries().map(([id, entry]) => [
        id,
        { count: entry.count, hits: entry.hits, unknown: entry.unknown, nudges: entry.nudges, lastSeenAt: entry.lastSeenAt, lastNudgedAt: entry.lastNudgedAt ?? null },
      ]),
    ),
    recentNudges: stats.recentNudges,
  };
}

function parseMuted(raw: JsonValue | undefined): Result<ReadonlySet<HerdrActionId>, InvalidStateFile> {
  if (!isJsonArray(raw)) return err(invalidStateFile("control", "muted"));
  const muted = new Set<HerdrActionId>();
  for (const id of raw) {
    if (!isString(id) || !isHerdrActionId(id)) return err(invalidStateFile("control", "muted"));
    muted.add(id);
  }
  return ok(muted);
}

export function parseControl(value: JsonValue | undefined): Result<Control, InvalidStateFile> {
  if (value === undefined) return ok(DEFAULT_CONTROL);
  if (!isJsonObject(value)) return err(invalidStateFile("control", "root"));
  const paused = value["paused"];
  if (!isBoolean(paused)) return err(invalidStateFile("control", "paused"));
  const muted = parseMuted(value["muted"]);
  return muted._tag === "err" ? muted : ok({ paused, muted: muted.value });
}

export function controlToJson(control: Control) {
  return { paused: control.paused, muted: [...control.muted].toSorted() };
}

export type Detection = {
  readonly action: HerdrActionId;
  readonly index?: number;
};

export type Nudge = {
  readonly title: string;
  readonly body: string;
};

export type SkipReason =
  | "disabled"
  | "paused"
  | "suppressed"
  | "cooldown"
  | "global-gap"
  | "hourly-cap"
  | "unbound"
  | "keyboard-estimate"
  | "unknown-input";

export type PolicyOutcome = {
  readonly stats: Stats;
  readonly nudge: Nudge | undefined;
  readonly skipped: SkipReason | undefined;
};

const HOUR_MS = 60 * 60 * 1000;

const POLICY = {
  cooldownMs: 10_000,
  minGapMs: 2000,
  maxPerHour: 40,
} as const;

type Bumped = { readonly stats: Stats; readonly entry: ActionStats };

function bump(stats: Stats, id: HerdrActionId, source: InputSource, now: number): Bumped {
  const previous = stats.actions.get(id) ?? { count: 0, hits: 0, unknown: 0, nudges: 0, lastSeenAt: now, lastNudgedAt: undefined };
  const keyboard = source === "key";
  const entry: ActionStats = {
    count: previous.count + (source === "mouse" ? 1 : 0),
    hits: previous.hits + (keyboard ? 1 : 0),
    unknown: previous.unknown + (source === "unknown" ? 1 : 0),
    nudges: previous.nudges,
    lastSeenAt: now,
    lastNudgedAt: previous.lastNudgedAt,
  };
  const actions = new Map(stats.actions);
  actions.set(id, entry);
  return { stats: { ...stats, actions }, entry };
}

function withNudge(stats: Stats, id: HerdrActionId, entry: ActionStats, now: number): Stats {
  const actions = new Map(stats.actions);
  actions.set(id, { ...entry, nudges: entry.nudges + 1, lastNudgedAt: now });
  const recentNudges = [...stats.recentNudges.filter((at) => now - at < HOUR_MS), now];
  return { ...stats, actions, recentNudges };
}

type SkipInput = {
  readonly entry: ActionStats;
  readonly id: HerdrActionId;
  readonly recentNudges: ReadonlyArray<number>;
  readonly now: number;
};

function gateSkip(input: SkipInput, settings: PluginConfig, control: Control): SkipReason | undefined {
  if (!settings.enabled) return "disabled";
  if (control.paused) return "paused";
  if (settings.suppressed.has(input.id) || control.muted.has(input.id)) return "suppressed";
  const { entry, now } = input;
  if (entry.lastNudgedAt !== undefined && now - entry.lastNudgedAt < POLICY.cooldownMs) return "cooldown";
  const lastNudge = input.recentNudges.at(-1);
  if (lastNudge !== undefined && now - lastNudge < POLICY.minGapMs) return "global-gap";
  if (input.recentNudges.filter((at) => now - at < HOUR_MS).length >= POLICY.maxPerHour) return "hourly-cap";
  return undefined;
}

function composeNudge(detection: Detection, entry: ActionStats, keys: string): Nudge {
  const spec = actionSpec(detection.action);
  const times = entry.count === 1 ? "once" : `${entry.count}×`;
  return {
    title: `${spec.title}: ${keys}`,
    body: `You've ${spec.didWhat} ${times}. Shortcut Shepherd`,
  };
}

export type ApplyInput = {
  readonly detection: Detection;
  readonly source: InputSource;
  readonly settings: PluginConfig;
  readonly control: Control;
  readonly keymap: Keymap;
  readonly now: number;
};

export function applyDetection(stats: Stats, input: ApplyInput): PolicyOutcome {
  const { detection, settings, control, keymap, now } = input;
  const bumped = bump(stats, detection.action, input.source, now);
  if (input.source === "unknown") return { stats: bumped.stats, nudge: undefined, skipped: "unknown-input" };
  if (input.source === "key") return { stats: bumped.stats, nudge: undefined, skipped: "keyboard-estimate" };
  const keys = bindingsFor(keymap, detection.action).map((binding) => formatBinding(keymap, binding, detection.index)).join(" or ");
  if (keys === "") return { stats: bumped.stats, nudge: undefined, skipped: "unbound" };
  const skipped = gateSkip(
    { entry: bumped.entry, id: detection.action, recentNudges: bumped.stats.recentNudges, now },
    settings,
    control,
  );
  if (skipped !== undefined) return { stats: bumped.stats, nudge: undefined, skipped };
  return {
    stats: withNudge(bumped.stats, detection.action, bumped.entry, now),
    nudge: composeNudge(detection, bumped.entry, keys),
    skipped: undefined,
  };
}

export type RankedAction = {
  readonly id: HerdrActionId;
  readonly title: string;
  readonly keys: string;
  readonly count: number;
  readonly hits: number;
  readonly unknown: number;
  readonly nudges: number;
  readonly suppressed: boolean;
};

function rankedRow(id: HerdrActionId, entry: ActionStats, settings: PluginConfig, keymap: Keymap): RankedAction {
  const bindings = bindingsFor(keymap, id);
  return {
    id,
    title: actionSpec(id).title,
    keys: bindings.length === 0 ? "(unbound)" : bindings.map((binding) => formatBinding(keymap, binding)).join(" / "),
    count: entry.count,
    hits: entry.hits,
    unknown: entry.unknown,
    nudges: entry.nudges,
    suppressed: settings.suppressed.has(id),
  };
}

export function rankActions(stats: Stats, settings: PluginConfig, keymap: Keymap): ReadonlyArray<RankedAction> {
  return stats.actions
    .entries()
    .map(([id, entry]) => rankedRow(id, entry, settings, keymap))
    .toArray()
    .toSorted((a, b) => b.count - a.count || (b.hits + b.unknown) - (a.hits + a.unknown) || a.title.localeCompare(b.title));
}

const SKIP_DESCRIPTIONS = {
  disabled: "nudges disabled in settings",
  paused: "paused",
  suppressed: "suppressed by user",
  cooldown: "per-action cooldown",
  "global-gap": "another toast was shown moments ago",
  "hourly-cap": "hourly cap reached",
  unbound: "no configured shortcut; counted without nudging",
  "keyboard-estimate": "recent keyboard activity (not a verified shortcut)",
  "unknown-input": "input source unknown; counted without nudging",
} as const satisfies Record<SkipReason, string>;

export function describeSkip(reason: SkipReason): string {
  return SKIP_DESCRIPTIONS[reason];
}
