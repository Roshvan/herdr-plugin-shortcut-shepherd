import { ok, err, type Result } from "./result.ts";
import {
  isBoolean,
  isJsonArray,
  isJsonObject,
  numberField,
  parseJsonText,
  stringField,
  type JsonObject,
  type JsonValue,
} from "./json.ts";

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type TabId = string & { readonly __brand: "TabId" };
export type PaneId = string & { readonly __brand: "PaneId" };

function workspaceId(raw: string): WorkspaceId {
  return raw as WorkspaceId;
}

function tabId(raw: string): TabId {
  return raw as TabId;
}

function paneId(raw: string): PaneId {
  return raw as PaneId;
}

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type PaneRect = { readonly paneId: PaneId; readonly rect: Rect };

export type TabLayout = {
  readonly workspaceId: WorkspaceId;
  readonly tabId: TabId;
  readonly zoomed: boolean;
  readonly focusedPaneId: PaneId;
  readonly panes: ReadonlyArray<PaneRect>;
};

type TabRecord = {
  readonly tabId: TabId;
  readonly workspaceId: WorkspaceId;
  readonly number: number;
};

type WorkspaceRecord = {
  readonly workspaceId: WorkspaceId;
  readonly number: number;
  readonly activeTabId: TabId;
  readonly isWorktree: boolean;
};

type PaneRecord = {
  readonly paneId: PaneId;
  readonly tabId: TabId;
  readonly workspaceId: WorkspaceId;
};

export type HerdrEvent =
  | { readonly type: "workspace_created"; readonly workspace: WorkspaceRecord }
  | { readonly type: "workspace_closed"; readonly workspaceId: WorkspaceId }
  | { readonly type: "workspace_renamed"; readonly workspaceId: WorkspaceId }
  | { readonly type: "workspace_moved"; readonly workspaces: ReadonlyArray<WorkspaceRecord> }
  | { readonly type: "workspace_reordered"; readonly workspaces: ReadonlyArray<WorkspaceRecord> }
  | { readonly type: "workspace_focused"; readonly workspaceId: WorkspaceId }
  | { readonly type: "worktree_created"; readonly workspaceId: WorkspaceId }
  | { readonly type: "worktree_opened"; readonly workspaceId: WorkspaceId }
  | { readonly type: "worktree_removed"; readonly workspaceId: WorkspaceId }
  | { readonly type: "tab_created"; readonly tab: TabRecord }
  | { readonly type: "tab_closed"; readonly tabId: TabId; readonly workspaceId: WorkspaceId }
  | { readonly type: "tab_renamed"; readonly tabId: TabId; readonly workspaceId: WorkspaceId }
  | {
      readonly type: "tab_moved";
      readonly tabId: TabId;
      readonly workspaceId: WorkspaceId;
      readonly tabs: ReadonlyArray<TabRecord>;
    }
  | { readonly type: "tab_focused"; readonly tabId: TabId; readonly workspaceId: WorkspaceId }
  | { readonly type: "pane_created"; readonly pane: PaneRecord }
  | { readonly type: "pane_closed"; readonly paneId: PaneId; readonly workspaceId: WorkspaceId }
  | { readonly type: "pane_focused"; readonly paneId: PaneId; readonly workspaceId: WorkspaceId }
  | { readonly type: "pane_moved"; readonly pane: PaneRecord; readonly previousTabId: TabId }
  | { readonly type: "pane_exited"; readonly paneId: PaneId; readonly workspaceId: WorkspaceId }
  | { readonly type: "layout_updated"; readonly layout: TabLayout };

export type HerdrEventType = HerdrEvent["type"];

export const SUBSCRIBED_EVENT_NAMES: ReadonlyArray<string> = [
  "workspace.created",
  "workspace.closed",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "layout.updated",
];

export type MalformedHerdrEvent = {
  readonly _tag: "MalformedHerdrEvent";
  readonly message: string;
  readonly eventType: string;
  readonly field: string;
};

export type IgnoredHerdrEvent = { readonly _tag: "IgnoredHerdrEvent"; readonly message: string; readonly eventType: string };

function malformedHerdrEvent(eventType: string, field: string): MalformedHerdrEvent {
  return { _tag: "MalformedHerdrEvent", message: `Malformed Herdr event ${eventType}: bad or missing field ${field}`, eventType, field };
}

function ignoredHerdrEvent(eventType: string): IgnoredHerdrEvent {
  return { _tag: "IgnoredHerdrEvent", message: `Ignored Herdr event ${eventType}`, eventType };
}

function parseWorkspaceRecord(value: JsonValue | undefined): WorkspaceRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  const id = stringField(value, "workspace_id");
  const number = numberField(value, "number");
  const activeTabId = stringField(value, "active_tab_id");
  if (id === undefined || number === undefined || activeTabId === undefined) return undefined;
  return {
    workspaceId: workspaceId(id),
    number,
    activeTabId: tabId(activeTabId),
    isWorktree: isJsonObject(value["worktree"]),
  };
}

function parseTabRecord(value: JsonValue | undefined): TabRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  const id = stringField(value, "tab_id");
  const workspace = stringField(value, "workspace_id");
  const number = numberField(value, "number");
  if (id === undefined || workspace === undefined || number === undefined) return undefined;
  return { tabId: tabId(id), workspaceId: workspaceId(workspace), number };
}

function parsePaneRecord(value: JsonValue | undefined): PaneRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  const id = stringField(value, "pane_id");
  const tab = stringField(value, "tab_id");
  const workspace = stringField(value, "workspace_id");
  if (id === undefined || tab === undefined || workspace === undefined) return undefined;
  return { paneId: paneId(id), tabId: tabId(tab), workspaceId: workspaceId(workspace) };
}

function parseRect(value: JsonValue | undefined): Rect | undefined {
  if (!isJsonObject(value)) return undefined;
  const x = numberField(value, "x");
  const y = numberField(value, "y");
  const width = numberField(value, "width");
  const height = numberField(value, "height");
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

function parsePaneRect(value: JsonValue | undefined): PaneRect | undefined {
  if (!isJsonObject(value)) return undefined;
  const id = stringField(value, "pane_id");
  const rect = parseRect(value["rect"]);
  if (id === undefined || rect === undefined) return undefined;
  return { paneId: paneId(id), rect };
}

function parseTabLayout(value: JsonValue | undefined): TabLayout | undefined {
  if (!isJsonObject(value)) return undefined;
  const workspace = stringField(value, "workspace_id");
  const tab = stringField(value, "tab_id");
  const focusedPane = stringField(value, "focused_pane_id");
  const zoomed = value["zoomed"];
  const panes = parseRecordList(value["panes"], parsePaneRect);
  if (workspace === undefined || tab === undefined || focusedPane === undefined || !isBoolean(zoomed) || panes === undefined) {
    return undefined;
  }
  return {
    workspaceId: workspaceId(workspace),
    tabId: tabId(tab),
    zoomed,
    focusedPaneId: paneId(focusedPane),
    panes,
  };
}

function parseRecordList<T>(
  value: JsonValue | undefined,
  parse: (item: JsonValue) => T | undefined,
): ReadonlyArray<T> | undefined {
  if (!isJsonArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

export function parseHerdrEventLine(line: string): Result<HerdrEvent, MalformedHerdrEvent | IgnoredHerdrEvent> {
  const parsed = parseJsonText("event", line);
  if (parsed._tag === "err") return err(malformedHerdrEvent("unknown", "json"));
  const envelope = parsed.value;
  if (!isJsonObject(envelope)) return err(malformedHerdrEvent("unknown", "envelope"));
  const eventType = stringField(envelope, "event");
  const data = envelope["data"];
  if (eventType === undefined) return err(ignoredHerdrEvent("response"));
  if (!isJsonObject(data)) return err(malformedHerdrEvent(eventType, "data"));
  return parseHerdrEventData(eventType, data);
}

type EventParse = Result<HerdrEvent, MalformedHerdrEvent>;
type DataParser = (eventType: string, data: JsonObject) => EventParse;

function requireString(eventType: string, data: JsonObject, key: string): Result<string, MalformedHerdrEvent> {
  const value = stringField(data, key);
  return value === undefined ? err(malformedHerdrEvent(eventType, key)) : ok(value);
}

function requireRecord<T>(
  eventType: string,
  data: JsonObject,
  key: string,
  parse: (value: JsonValue | undefined) => T | undefined,
): Result<T, MalformedHerdrEvent> {
  const value = parse(data[key]);
  return value === undefined ? err(malformedHerdrEvent(eventType, key)) : ok(value);
}

function mapOk<T>(result: Result<T, MalformedHerdrEvent>, build: (value: T) => HerdrEvent): EventParse {
  return result._tag === "ok" ? ok(build(result.value)) : result;
}

function workspaceIdEvent(type: "workspace_closed" | "workspace_renamed" | "workspace_focused" | "worktree_removed"): DataParser {
  return (eventType, data) => mapOk(requireString(eventType, data, "workspace_id"), (id) => ({ type, workspaceId: workspaceId(id) }));
}

function tabIdEvent(type: "tab_closed" | "tab_renamed" | "tab_focused"): DataParser {
  return (eventType, data) => {
    const tab = requireString(eventType, data, "tab_id");
    if (tab._tag === "err") return tab;
    return mapOk(requireString(eventType, data, "workspace_id"), (workspace) => ({
      type,
      tabId: tabId(tab.value),
      workspaceId: workspaceId(workspace),
    }));
  };
}

function paneIdEvent(type: "pane_closed" | "pane_focused" | "pane_exited"): DataParser {
  return (eventType, data) => {
    const pane = requireString(eventType, data, "pane_id");
    if (pane._tag === "err") return pane;
    return mapOk(requireString(eventType, data, "workspace_id"), (workspace) => ({
      type,
      paneId: paneId(pane.value),
      workspaceId: workspaceId(workspace),
    }));
  };
}

function workspaceListEvent(type: "workspace_moved" | "workspace_reordered"): DataParser {
  return (eventType, data) =>
    mapOk(
      requireRecord(eventType, data, "workspaces", (value) => parseRecordList(value, parseWorkspaceRecord)),
      (workspaces) => ({ type, workspaces }),
    );
}

function worktreeWorkspaceEvent(type: "worktree_created" | "worktree_opened"): DataParser {
  return (eventType, data) =>
    mapOk(requireRecord(eventType, data, "workspace", parseWorkspaceRecord), (workspace) => ({
      type,
      workspaceId: workspace.workspaceId,
    }));
}

const parseTabMoved: DataParser = (eventType, data) => {
  const tab = requireString(eventType, data, "tab_id");
  if (tab._tag === "err") return tab;
  const workspace = requireString(eventType, data, "workspace_id");
  if (workspace._tag === "err") return workspace;
  return mapOk(
    requireRecord(eventType, data, "tabs", (value) => parseRecordList(value, parseTabRecord)),
    (tabs) => ({ type: "tab_moved", tabId: tabId(tab.value), workspaceId: workspaceId(workspace.value), tabs }),
  );
};

const parsePaneMoved: DataParser = (eventType, data) => {
  const pane = requireRecord(eventType, data, "pane", parsePaneRecord);
  if (pane._tag === "err") return pane;
  return mapOk(requireString(eventType, data, "previous_tab_id"), (previous) => ({
    type: "pane_moved",
    pane: pane.value,
    previousTabId: tabId(previous),
  }));
};

const DATA_PARSERS: ReadonlyMap<string, DataParser> = new Map<string, DataParser>([
  ["workspace_created", (t, d) => mapOk(requireRecord(t, d, "workspace", parseWorkspaceRecord), (workspace) => ({ type: "workspace_created", workspace }))],
  ["workspace_closed", workspaceIdEvent("workspace_closed")],
  ["workspace_renamed", workspaceIdEvent("workspace_renamed")],
  ["workspace_focused", workspaceIdEvent("workspace_focused")],
  ["workspace_moved", workspaceListEvent("workspace_moved")],
  ["workspace_reordered", workspaceListEvent("workspace_reordered")],
  ["worktree_created", worktreeWorkspaceEvent("worktree_created")],
  ["worktree_opened", worktreeWorkspaceEvent("worktree_opened")],
  ["worktree_removed", workspaceIdEvent("worktree_removed")],
  ["tab_created", (t, d) => mapOk(requireRecord(t, d, "tab", parseTabRecord), (tab) => ({ type: "tab_created", tab }))],
  ["tab_closed", tabIdEvent("tab_closed")],
  ["tab_renamed", tabIdEvent("tab_renamed")],
  ["tab_focused", tabIdEvent("tab_focused")],
  ["tab_moved", parseTabMoved],
  ["pane_created", (t, d) => mapOk(requireRecord(t, d, "pane", parsePaneRecord), (pane) => ({ type: "pane_created", pane }))],
  ["pane_closed", paneIdEvent("pane_closed")],
  ["pane_focused", paneIdEvent("pane_focused")],
  ["pane_exited", paneIdEvent("pane_exited")],
  ["pane_moved", parsePaneMoved],
  ["layout_updated", (t, d) => mapOk(requireRecord(t, d, "layout", parseTabLayout), (layout) => ({ type: "layout_updated", layout }))],
]);

function parseHerdrEventData(eventType: string, data: JsonObject): Result<HerdrEvent, MalformedHerdrEvent | IgnoredHerdrEvent> {
  const parser = DATA_PARSERS.get(eventType);
  if (parser === undefined) return err(ignoredHerdrEvent(eventType));
  return parser(eventType, data);
}

export type SessionSnapshot = {
  readonly focusedWorkspaceId: WorkspaceId | undefined;
  readonly focusedTabId: TabId | undefined;
  readonly focusedPaneId: PaneId | undefined;
  readonly workspaces: ReadonlyArray<WorkspaceRecord>;
  readonly tabs: ReadonlyArray<TabRecord>;
  readonly panes: ReadonlyArray<PaneRecord>;
  readonly layouts: ReadonlyArray<TabLayout>;
};

export type MalformedSessionSnapshot = { readonly _tag: "MalformedSessionSnapshot"; readonly message: string; readonly field: string };

function malformedSessionSnapshot(field: string): MalformedSessionSnapshot {
  return { _tag: "MalformedSessionSnapshot", message: `Malformed session.snapshot response: bad or missing field ${field}`, field };
}

function optionalId<T>(obj: JsonObject, key: string, brand: (raw: string) => T): T | undefined {
  const raw = stringField(obj, key);
  return raw === undefined ? undefined : brand(raw);
}

export function parseSessionSnapshot(value: JsonValue): Result<SessionSnapshot, MalformedSessionSnapshot> {
  if (!isJsonObject(value)) return err(malformedSessionSnapshot("result"));
  const inner = value["snapshot"];
  if (!isJsonObject(inner)) return err(malformedSessionSnapshot("snapshot"));
  const workspaces = parseRecordList(inner["workspaces"], parseWorkspaceRecord);
  if (workspaces === undefined) return err(malformedSessionSnapshot("workspaces"));
  const tabs = parseRecordList(inner["tabs"], parseTabRecord);
  if (tabs === undefined) return err(malformedSessionSnapshot("tabs"));
  const panes = parseRecordList(inner["panes"], parsePaneRecord);
  if (panes === undefined) return err(malformedSessionSnapshot("panes"));
  const layouts = parseRecordList(inner["layouts"], parseTabLayout);
  if (layouts === undefined) return err(malformedSessionSnapshot("layouts"));
  return ok({
    focusedWorkspaceId: optionalId(inner, "focused_workspace_id", workspaceId),
    focusedTabId: optionalId(inner, "focused_tab_id", tabId),
    focusedPaneId: optionalId(inner, "focused_pane_id", paneId),
    workspaces,
    tabs,
    panes,
    layouts,
  });
}
