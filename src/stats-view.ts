import stringWidth from "string-width";
import { parseConfig, type PluginConfig } from "./config.ts";
import { isJsonArray, isJsonObject, isString, stringField, type JsonValue } from "./json.ts";
import { buildKeymap, isHerdrActionId, type HerdrActionId, type Keymap } from "./keymap.ts";
import { parseControl, parseStats, rankActions, type Control, type RankedAction, type Stats } from "./nudge-policy.ts";
import { err, ok, type Result } from "./result.ts";

/** A parsed, coherent watcher view. UI controls never write state files directly. */
export type StatsView = {
  readonly sessionId: string;
  readonly connection: string;
  readonly inputMode: string;
  readonly settings: PluginConfig;
  readonly control: Control;
  readonly stats: Stats;
  readonly keymap: Keymap;
  readonly warning: string | undefined;
};

/** Malformed status data is surfaced without replacing a good view with empty defaults. */
export type InvalidStatsView = { readonly _tag: "InvalidStatsView"; readonly message: string };

function invalid(): InvalidStatsView { return { _tag: "InvalidStatsView", message: "Watcher returned an incomplete stats view" }; }

function parseKeymap(value: JsonValue | undefined): Keymap | undefined {
  if (!isJsonObject(value)) return undefined;
  const prefix = stringField(value, "prefix");
  const raw = value["bindings"];
  if (prefix === undefined || !isJsonObject(raw)) return undefined;
  const bindings = new Map<HerdrActionId, ReadonlyArray<string>>();
  for (const [id, keys] of Object.entries(raw)) {
    if (!isHerdrActionId(id) || !isJsonArray(keys)) return undefined;
    const strings: string[] = [];
    for (const key of keys) { if (!isString(key)) return undefined; strings.push(key); }
    bindings.set(id, strings);
  }
  return buildKeymap({ prefix, bindings });
}

type ViewContent = Pick<StatsView, "settings" | "control" | "stats">;

function parseContent(value: JsonValue, now: number): Result<ViewContent, InvalidStatsView> {
  if (!isJsonObject(value)) return err(invalid());
  if (![value["config"], value["control"], value["stats"]].every(isJsonObject)) return err(invalid());
  const settings = parseConfig(value["config"]);
  const control = parseControl(value["control"]);
  const stats = parseStats(value["stats"], now);
  if (settings._tag === "err" || control._tag === "err" || stats._tag === "err") return err(invalid());
  return ok({ settings: settings.value, control: control.value, stats: stats.value });
}

/** Parse the private control protocol at the presentation boundary. */
export function parseStatsView(value: JsonValue, now: number): Result<StatsView, InvalidStatsView> {
  if (!isJsonObject(value)) return err(invalid());
  const sessionId = stringField(value, "sessionId");
  const connection = stringField(value, "connection");
  const inputMode = stringField(value, "inputMode");
  const keymap = parseKeymap(value["keymap"]);
  if (sessionId === undefined || connection === undefined || inputMode === undefined || keymap === undefined) return err(invalid());
  const content = parseContent(value, now);
  if (content._tag === "err") return content;
  return ok({ sessionId, connection, inputMode, keymap, ...content.value,
    warning: stringField(value, "configWarning") ?? stringField(value, "keymapWarning"),
  });
}

/** Rank local counts, including mute state from the session and shared settings. */
export function viewRows(view: StatsView): ReadonlyArray<RankedAction> {
  return rankActions(view.stats, { ...view.settings, suppressed: new Set([...view.settings.suppressed, ...view.control.muted]) }, view.keymap);
}

/** Terminal selection and acknowledgment state. */
export type StatsUi = { cursor: number; confirmReset: boolean; message: string };

function clean(text: string): string {
  // oxlint-disable-next-line no-control-regex -- Untrusted text must not inject ANSI or other terminal controls.
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
}
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function fit(text: string, width: number): string {
  const safe = clean(text);
  const cells = stringWidth(safe);
  if (cells <= width) return safe + " ".repeat(width - cells);
  let out = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(safe)) {
    const next = stringWidth(segment);
    if (used + next > width - 1) break;
    out += segment;
    used += next;
  }
  return `${out}…${" ".repeat(Math.max(0, width - used - 1))}`;
}

function tableHeader(columns: number): string {
  const titleWidth = columns >= 100 ? 22 : 16;
  const hintsWidth = columns >= 100 ? 8 : 0;
  const cells = [fit("#", 3), fit("Action", titleWidth), fit("Configured shortcut", columns - titleWidth - 30 - hintsWidth), fit("Mouse~", 6), fit("Keys~", 6), fit("Unknown", 7)];
  if (hintsWidth > 0) cells.push(fit("Hints", 7));
  return cells.join(" ");
}

function tableRow(row: RankedAction, rank: number, columns: number): string {
  const titleWidth = columns >= 100 ? 22 : 16;
  const hintsWidth = columns >= 100 ? 8 : 0;
  const keysWidth = columns - titleWidth - 30 - hintsWidth;
  const cells = [fit(String(rank), 3), fit(`${row.suppressed ? "* " : ""}${row.title}`, titleWidth), fit(row.keys, keysWidth),
    fit(String(row.count), 6), fit(String(row.hits), 6), fit(String(row.unknown), 7)];
  if (hintsWidth > 0) cells.push(fit(String(row.nudges), 7));
  return cells.join(" ");
}

function footerLines(ui: StatsUi, compact: boolean): string[] {
  const footer = ui.confirmReset ? ["Reset session statistics? [y/N]"] : compact
    ? ["[j/k] move [s] mute [p] pause", "[r] reset [b] keys [q] quit"]
    : ["[j/k] move [s] mute [p] pause [r] reset [b] keys [q] quit"];
  if (ui.message !== "") footer.push(ui.message);
  return footer;
}

/** Render within explicit viewport bounds using the existing terminal theme and keyboard affordances. */
export function renderStatsView(view: StatsView, ui: StatsUi, columns: number, height: number): string {
  const width = Math.max(1, columns - 1);
  const rows = viewRows(view);
  const mode = !view.settings.enabled ? "nudges disabled" : view.control.paused ? "nudges paused" : "nudges on";
  const compact = width < 70;
  const header = [
    `Shortcut Shepherd · session ${view.sessionId.slice(0, 8)}`,
    `${view.connection} · input: ${view.inputMode} · ${mode}`,
    compact ? "M~/K~ = estimates. ? = unknown." : "Mouse~/Keys~ estimate local activity, not shortcuts. ? = unknown.",
    compact ? "Reload Herdr, then [b] refresh keys." : "Configured shortcuts; reload Herdr before [b] refresh.",
  ];
  if (view.warning !== undefined) header.push(`Warning: ${view.warning}`);
  const footer = footerLines(ui, compact);
  if (!compact) header.push(tableHeader(width));
  const capacity = Math.max(0, height - header.length - footer.length);
  const visible = Math.floor(capacity / (compact ? 2 : 1));
  const start = Math.max(0, Math.min(ui.cursor - Math.floor(visible / 2), rows.length - visible));
  const body: string[] = [];
  if (rows.length === 0 && capacity > 0) body.push("No actions yet. Use Herdr; unknown input counts without nudges.");
  rows.slice(start, start + visible).forEach((row, offset) => {
    const index = start + offset;
    const lines = compact ? [`${index + 1}. ${row.suppressed ? "* " : ""}${row.title} M~:${row.count} K~:${row.hits} ?:${row.unknown}`, row.keys] : [tableRow(row, index + 1, width)];
    for (const line of lines) body.push(index === ui.cursor ? `\u001b[7m${fit(line, width)}\u001b[0m` : fit(line, width));
  });
  const plainHeader = header.slice(0, Math.max(0, height - footer.length)).map((line) => fit(line, width));
  const boundedBody = body.slice(0, Math.max(0, height - plainHeader.length - footer.length));
  return "\u001b[2J\u001b[H" + [...plainHeader, ...boundedBody, ...footer.map((line) => fit(line, width))].slice(0, height).join("\n");
}
