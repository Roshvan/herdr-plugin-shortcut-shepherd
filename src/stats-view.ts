import stringWidth from "string-width";
import { parseConfig, type PluginConfig } from "./config.ts";
import { isJsonArray, isJsonObject, isString, stringField, type JsonValue } from "./json.ts";
import { buildKeymap, isHerdrActionId, type HerdrActionId, type Keymap } from "./keymap.ts";
import { parseControl, parseStats, rankActions, type Control, type RankedAction, type Stats } from "./nudge-policy.ts";
import { err, ok, type Result } from "./result.ts";

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

export function viewRows(view: StatsView): ReadonlyArray<RankedAction> {
  const rows = rankActions(view.stats, { ...view.settings, suppressed: new Set([...view.settings.suppressed, ...view.control.muted]) }, view.keymap);
  return view.inputMode === "local-estimate" ? rows : rows.toSorted((a, b) => uses(b) - uses(a) || a.title.localeCompare(b.title));
}

function uses(row: RankedAction): number { return row.count + row.hits + row.unknown; }

export type StatsUi = { cursor: number; confirmReset: boolean; message: string };

function clean(text: string): string {
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

type CountDisplay = "uses" | "estimates";

function tableHeader(columns: number, display: CountDisplay): string {
  const titleWidth = display === "uses" || columns >= 100 ? 22 : 16;
  if (display === "uses") return [fit("#", 3), fit("Action", titleWidth), fit("Configured shortcut", columns - titleWidth - 13), fit("Uses", 7)].join(" ");
  const hintsWidth = columns >= 100 ? 8 : 0;
  const cells = [fit("#", 3), fit("Action", titleWidth), fit("Configured shortcut", columns - titleWidth - 30 - hintsWidth), fit("Mouse~", 6), fit("Keys~", 6), fit("Unknown", 7)];
  if (hintsWidth > 0) cells.push(fit("Hints", 7));
  return cells.join(" ");
}

function tableRow(row: RankedAction, rank: number, columns: number, display: CountDisplay): string {
  const titleWidth = display === "uses" || columns >= 100 ? 22 : 16;
  const title = `${row.suppressed ? "* " : ""}${row.title}`;
  if (display === "uses") return [fit(String(rank), 3), fit(title, titleWidth), fit(row.keys, columns - titleWidth - 13), fit(String(uses(row)), 7)].join(" ");
  const hintsWidth = columns >= 100 ? 8 : 0;
  const keysWidth = columns - titleWidth - 30 - hintsWidth;
  const cells = [fit(String(rank), 3), fit(title, titleWidth), fit(row.keys, keysWidth),
    fit(String(row.count), 6), fit(String(row.hits), 6), fit(String(row.unknown), 7)];
  if (hintsWidth > 0) cells.push(fit(String(row.nudges), 7));
  return cells.join(" ");
}

function reminderStatus(view: StatsView): string {
  if (!view.settings.enabled) return "reminders disabled";
  if (view.control.paused) return "reminders paused";
  if (view.inputMode === "off") return "reminders off · monitoring off";
  if (view.inputMode !== "local-estimate") return "reminders off · input unavailable";
  return "local input estimates";
}

function compactRow(row: RankedAction, rank: number, display: CountDisplay): string {
  const counts = display === "uses" ? `Uses:${uses(row)}` : `M~:${row.count} K~:${row.hits} ?:${row.unknown}`;
  return `${rank}. ${row.suppressed ? "* " : ""}${row.title} ${counts}`;
}

function footerLines(ui: StatsUi, compact: boolean): string[] {
  const footer = ui.confirmReset ? ["Reset session statistics? [y/N]"] : compact
    ? ["[j/k] move [s] mute [p] pause", "[r] reset [b] keys [q] quit"]
    : ["[j/k] move [s] mute [p] pause [r] reset [b] keys [q] quit"];
  if (ui.message !== "") footer.push(ui.message);
  return footer;
}

export function renderStatsView(view: StatsView, ui: StatsUi, columns: number, height: number): string {
  const width = Math.max(1, columns - 1);
  const rows = viewRows(view);
  const display: CountDisplay = view.inputMode === "local-estimate" ? "estimates" : "uses";
  const compact = width < 70;
  const header = [
    `Shortcut Shepherd · session ${view.sessionId.slice(0, 8)}`,
    `${view.connection} · ${reminderStatus(view)}`,
    display === "uses" ? "Uses = detected actions in this session." : compact ? "M~/K~ = estimates. ? = unknown." : "Mouse~/Keys~ estimate local activity, not shortcuts. Unknown = input unavailable.",
    compact ? "Reload Herdr, then [b] refresh keys." : "Configured shortcuts; reload Herdr before [b] refresh.",
  ];
  if (view.warning !== undefined) header.push(`Warning: ${view.warning}`);
  const footer = footerLines(ui, compact);
  if (!compact) header.push(tableHeader(width, display));
  const capacity = Math.max(0, height - header.length - footer.length);
  const visible = Math.floor(capacity / (compact ? 2 : 1));
  const start = Math.max(0, Math.min(ui.cursor - Math.floor(visible / 2), rows.length - visible));
  const body: string[] = [];
  if (rows.length === 0 && capacity > 0) body.push("No actions yet. Open a tab, split a pane, or switch workspaces.");
  rows.slice(start, start + visible).forEach((row, offset) => {
    const index = start + offset;
    const lines = compact ? [compactRow(row, index + 1, display), row.keys] : [tableRow(row, index + 1, width, display)];
    for (const line of lines) body.push(index === ui.cursor ? `\u001b[7m${fit(line, width)}\u001b[0m` : fit(line, width));
  });
  const plainHeader = header.slice(0, Math.max(0, height - footer.length)).map((line) => fit(line, width));
  const boundedBody = body.slice(0, Math.max(0, height - plainHeader.length - footer.length));
  return "\u001b[2J\u001b[H" + [...plainHeader, ...boundedBody, ...footer.map((line) => fit(line, width))].slice(0, height).join("\n");
}
