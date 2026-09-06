import type {
  HerdrEvent,
  HerdrEventType,
  PaneId,
  Rect,
  SessionSnapshot,
  TabId,
  TabLayout,
  WorkspaceId,
} from "./herdr-event.ts";
import type { Detection } from "./nudge-policy.ts";
import type { HerdrActionId } from "./keymap.ts";

export const INFERENCE = {
  settleMs: 700,
  cascadeMs: 1500,
  focusSideEffectMs: 600,
  resizeBurstMs: 1200,
  sameActionMinGapMs: 500,
  navigationMinGapMs: 1500,
  stormWindowMs: 3000,
  stormThreshold: 5,
  stormLongWindowMs: 30_000,
  stormLongThreshold: 12,
  workspaceDwellMs: 2000,
  warmupMs: 3000,
  replayQuietMs: 1500,
  recentKeepMs: 5000,
  maxQueuedEvents: 4096,
} as const;

type Stamped = { readonly event: HerdrEvent; readonly at: number };

/** Owned topology and delayed events; snapshot revisions keep reconnect warm-up attempts distinct. */
export type InferenceState = {
  readonly workspaces: WorkspaceId[];
  readonly worktreeWorkspaces: Set<WorkspaceId>;
  readonly tabsByWorkspace: Map<WorkspaceId, TabId[]>;
  readonly focusedTabByWorkspace: Map<WorkspaceId, TabId>;
  readonly focusedPaneByTab: Map<TabId, PaneId>;
  readonly tabOfPane: Map<PaneId, TabId>;
  readonly layouts: Map<TabId, TabLayout>;
  readonly lastDetectionAt: Map<HerdrActionId, number>;
  focusedWorkspace: WorkspaceId | undefined;
  pending: Stamped[];
  recent: Stamped[];
  recentDetectionTimes: number[];
  stormUntil: number;
  warmupUntil: number;
  warmupRevision: number;
  warmedUp: boolean;
  droppedAsAutomation: number;
  droppedInWarmup: number;
};

export function createInference(): InferenceState {
  return {
    workspaces: [],
    worktreeWorkspaces: new Set(),
    tabsByWorkspace: new Map(),
    focusedTabByWorkspace: new Map(),
    focusedPaneByTab: new Map(),
    tabOfPane: new Map(),
    layouts: new Map(),
    lastDetectionAt: new Map(),
    focusedWorkspace: undefined,
    pending: [],
    recent: [],
    recentDetectionTimes: [],
    stormUntil: 0,
    warmupUntil: 0,
    warmupRevision: 0,
    warmedUp: true,
    droppedAsAutomation: 0,
    droppedInWarmup: 0,
  };
}

/** Suspend attribution until a quiet-period snapshot succeeds, invalidating earlier snapshot attempts. */
export function beginWarmup(state: InferenceState, now: number): void {
  state.warmupRevision += 1;
  state.warmupUntil = now + INFERENCE.warmupMs;
  state.warmedUp = false;
}

export function installSnapshot(state: InferenceState, snapshot: SessionSnapshot, now: number): void {
  beginWarmup(state, now);
  loadSnapshot(state, snapshot);
}

/** End warm-up with an authoritative snapshot, discarding superseded queued events. */
export function resyncSnapshot(state: InferenceState, snapshot: SessionSnapshot): void {
  // A snapshot supersedes queued events received before it. Replaying them afterward
  // would apply old topology to the newer snapshot and fabricate detections.
  state.pending = [];
  state.recent = [];
  loadSnapshot(state, snapshot);
  state.warmedUp = true;
}

function loadSnapshot(state: InferenceState, snapshot: SessionSnapshot): void {
  state.workspaces.length = 0;
  state.worktreeWorkspaces.clear();
  state.tabsByWorkspace.clear();
  state.focusedTabByWorkspace.clear();
  state.focusedPaneByTab.clear();
  state.tabOfPane.clear();
  state.layouts.clear();
  for (const ws of snapshot.workspaces.toSorted((a, b) => a.number - b.number)) {
    state.workspaces.push(ws.workspaceId);
    if (ws.isWorktree) state.worktreeWorkspaces.add(ws.workspaceId);
    state.focusedTabByWorkspace.set(ws.workspaceId, ws.activeTabId);
  }
  for (const tab of snapshot.tabs.toSorted((a, b) => a.number - b.number)) tabList(state, tab.workspaceId).push(tab.tabId);
  for (const pane of snapshot.panes) state.tabOfPane.set(pane.paneId, pane.tabId);
  for (const layout of snapshot.layouts) {
    state.layouts.set(layout.tabId, layout);
    state.focusedPaneByTab.set(layout.tabId, layout.focusedPaneId);
  }
  state.focusedWorkspace = snapshot.focusedWorkspaceId;
  if (snapshot.focusedTabId !== undefined && snapshot.focusedPaneId !== undefined) {
    state.focusedPaneByTab.set(snapshot.focusedTabId, snapshot.focusedPaneId);
  }
}

/** Enqueue a lifecycle event; overload fails closed into a fresh warm-up/snapshot cycle. */
export function observe(state: InferenceState, event: HerdrEvent, at: number): void {
  if (state.pending.length >= INFERENCE.maxQueuedEvents) {
    state.droppedAsAutomation += state.pending.length;
    state.pending = [];
    state.recent = [];
    beginWarmup(state, at);
  }
  if (!state.warmedUp) {
    // Any replay activity invalidates a quiet-period snapshot already in flight.
    state.warmupRevision += 1;
    state.warmupUntil = Math.max(state.warmupUntil, at + INFERENCE.replayQuietMs);
  }
  state.pending.push({ event, at });
  state.recent.push({ event, at });
}

/** Whether the quiet period permits a snapshot attempt; only its success ends uncertainty. */
export function warmupJustEnded(state: InferenceState, now: number): boolean {
  return !state.warmedUp && now >= state.warmupUntil;
}

export type Detected = { readonly detection: Detection; readonly at: number };

/** Earliest real clock time at which the queue head can settle; undefined means drained. */
export function nextSettlementAt(state: InferenceState): number | undefined {
  const head = state.pending[0];
  return head === undefined ? undefined : head.at + settleDelayFor(head.event);
}

/** Settle mature events in order at the supplied real clock time; unresolved warm-up stays uncounted. */
export function settle(state: InferenceState, now: number): ReadonlyArray<Detected> {
  const detections: Detected[] = [];
  while (state.pending.length > 0) {
    const head = state.pending[0];
    if (head === undefined || now - head.at < settleDelayFor(head.event)) break;
    state.pending.shift();
    const detection = evaluate(state, head.event, head.at);
    apply(state, head.event);
    if (detection !== undefined && isHumanPaced(state, detection, head.at)) detections.push({ detection, at: head.at });
  }
  state.recent = state.recent.filter((entry) => now - entry.at < INFERENCE.recentKeepMs);
  return detections;
}

export function takeDroppedCount(state: InferenceState): number {
  const dropped = state.droppedAsAutomation;
  state.droppedAsAutomation = 0;
  return dropped;
}

export function takeWarmupDroppedCount(state: InferenceState): number {
  const dropped = state.droppedInWarmup;
  state.droppedInWarmup = 0;
  return dropped;
}

function isHumanPaced(state: InferenceState, detection: Detection, at: number): boolean {
  if (!state.warmedUp || at < state.warmupUntil) {
    state.droppedInWarmup += 1;
    return false;
  }
  state.recentDetectionTimes = state.recentDetectionTimes.filter((t) => at - t < INFERENCE.stormLongWindowMs);
  state.recentDetectionTimes.push(at);
  const previous = state.lastDetectionAt.get(detection.action);
  state.lastDetectionAt.set(detection.action, at);
  const inShortWindow = state.recentDetectionTimes.filter((t) => at - t < INFERENCE.stormWindowMs).length;
  if (inShortWindow > INFERENCE.stormThreshold) state.stormUntil = Math.max(state.stormUntil, at + INFERENCE.stormWindowMs);
  if (state.recentDetectionTimes.length > INFERENCE.stormLongThreshold) {
    state.stormUntil = Math.max(state.stormUntil, at + INFERENCE.stormLongWindowMs);
  }
  const paced = at >= state.stormUntil && (previous === undefined || at - previous >= minGapFor(detection.action));
  if (!paced) state.droppedAsAutomation += 1;
  return paced;
}

function tabList(state: InferenceState, workspaceId: WorkspaceId): TabId[] {
  const existing = state.tabsByWorkspace.get(workspaceId);
  if (existing !== undefined) return existing;
  const created: TabId[] = [];
  state.tabsByWorkspace.set(workspaceId, created);
  return created;
}

function near(
  state: InferenceState,
  at: number,
  windowMs: number,
  types: ReadonlyArray<HerdrEventType>,
  predicate: (event: HerdrEvent) => boolean,
): boolean {
  // Callers ask about related lifecycle types, not the event being evaluated.
  // Distinct events in one socket batch can legitimately have the same timestamp.
  return state.recent.some(
    (entry) => Math.abs(entry.at - at) <= windowMs && types.includes(entry.event.type) && predicate(entry.event),
  );
}

function isOnScreen(state: InferenceState, workspaceId: WorkspaceId, tabId?: TabId): boolean {
  if (state.focusedWorkspace === undefined) return true;
  if (state.focusedWorkspace !== workspaceId) return false;
  if (tabId === undefined) return true;
  const focusedTab = state.focusedTabByWorkspace.get(workspaceId);
  return focusedTab === undefined || focusedTab === tabId;
}

function nearWorkspaceStructure(state: InferenceState, at: number, workspaceId: WorkspaceId): boolean {
  return near(
    state,
    at,
    INFERENCE.cascadeMs,
    ["workspace_created", "workspace_closed", "worktree_created", "worktree_opened", "worktree_removed"],
    (e) => ("workspaceId" in e ? e.workspaceId === workspaceId : e.type === "workspace_created" && e.workspace.workspaceId === workspaceId),
  );
}

function nearTabStructure(state: InferenceState, at: number, tabId: TabId, workspaceId: WorkspaceId): boolean {
  return (
    near(state, at, INFERENCE.cascadeMs, ["tab_created", "tab_closed"], (e) =>
      e.type === "tab_created" ? e.tab.tabId === tabId : e.type === "tab_closed" && e.tabId === tabId,
    ) || nearWorkspaceStructure(state, at, workspaceId)
  );
}

function evaluate(state: InferenceState, event: HerdrEvent, at: number): Detection | undefined {
  if (event.type.startsWith("workspace_") || event.type.startsWith("worktree_")) return evaluateWorkspaceEvent(state, event, at);
  if (event.type.startsWith("tab_")) return evaluateTabEvent(state, event, at);
  return evaluatePaneEvent(state, event, at);
}

function evaluateWorkspaceEvent(state: InferenceState, event: HerdrEvent, at: number): Detection | undefined {
  switch (event.type) {
    case "workspace_created":
      return evaluateWorkspaceCreated(state, event.workspace.workspaceId, event.workspace.isWorktree, at);
    case "workspace_closed":
      return near(state, at, INFERENCE.cascadeMs, ["worktree_removed"], (e) => e.type === "worktree_removed" && e.workspaceId === event.workspaceId)
        ? undefined
        : { action: "close_workspace" };
    case "workspace_renamed":
      return { action: "rename_workspace" };
    case "workspace_focused":
      return evaluateWorkspaceFocused(state, event.workspaceId, at);
    default:
      return undefined;
  }
}

function tabEventWorkspace(event: HerdrEvent): WorkspaceId | undefined {
  if (event.type === "tab_created") return event.tab.workspaceId;
  return "workspaceId" in event ? event.workspaceId : undefined;
}

function evaluateTabEvent(state: InferenceState, event: HerdrEvent, at: number): Detection | undefined {
  const workspaceId = tabEventWorkspace(event);
  if (workspaceId !== undefined && !isOnScreen(state, workspaceId)) return undefined;
  switch (event.type) {
    case "tab_created":
      return nearWorkspaceStructure(state, at, event.tab.workspaceId) ? undefined : { action: "new_tab" };
    case "tab_closed":
      return evaluateTabClosed(state, event.tabId, event.workspaceId, at);
    case "tab_renamed":
      return { action: "rename_tab" };
    case "tab_moved":
      return evaluateTabMoved(state, event.tabId, event.workspaceId, event.tabs.map((tab) => tab.tabId));
    case "tab_focused":
      return evaluateTabFocused(state, event.tabId, event.workspaceId, at);
    default:
      return undefined;
  }
}

function evaluatePaneEvent(state: InferenceState, event: HerdrEvent, at: number): Detection | undefined {
  switch (event.type) {
    case "pane_created":
      if (!isOnScreen(state, event.pane.workspaceId, event.pane.tabId)) return undefined;
      return evaluatePaneCreated(state, event.pane, at);
    case "pane_closed":
      if (!isOnScreen(state, event.workspaceId, state.tabOfPane.get(event.paneId))) return undefined;
      return evaluatePaneClosed(state, event.paneId, event.workspaceId, at);
    case "pane_focused":
      if (!isOnScreen(state, event.workspaceId, state.tabOfPane.get(event.paneId))) return undefined;
      return evaluatePaneFocused(state, event.paneId, event.workspaceId, at);
    case "layout_updated":
      if (!isOnScreen(state, event.layout.workspaceId, event.layout.tabId)) return undefined;
      return evaluateLayoutUpdated(state, event.layout, at);
    default:
      return undefined;
  }
}

function evaluateWorkspaceCreated(state: InferenceState, workspaceId: WorkspaceId, isWorktree: boolean, at: number): Detection | undefined {
  if (isWorktree) return undefined;
  const worktreeFlow = near(
    state,
    at,
    INFERENCE.cascadeMs,
    ["worktree_created", "worktree_opened"],
    (e) => (e.type === "worktree_created" || e.type === "worktree_opened") && e.workspaceId === workspaceId,
  );
  return worktreeFlow ? undefined : { action: "new_workspace" };
}

function workspaceJump(from: number, to: number, count: number): Detection {
  if (from === -1 || to === -1) return { action: "workspace_picker" };
  if (count === 2) return { action: "next_workspace" };
  if (to === (from + 1) % count) return { action: "next_workspace" };
  if (to === (from - 1 + count) % count) return { action: "previous_workspace" };
  return { action: "workspace_picker", index: to + 1 };
}

function evaluateWorkspaceFocused(state: InferenceState, workspaceId: WorkspaceId, at: number): Detection | undefined {
  if (nearWorkspaceStructure(state, at, workspaceId)) return undefined;
  const movedOnAgain = state.recent.some(
    (entry) => entry.at > at && entry.at - at <= INFERENCE.workspaceDwellMs && entry.event.type === "workspace_focused",
  );
  if (movedOnAgain) return undefined;
  const previous = state.focusedWorkspace;
  if (previous === undefined || previous === workspaceId) return undefined;
  return workspaceJump(state.workspaces.indexOf(previous), state.workspaces.indexOf(workspaceId), state.workspaces.length);
}

function evaluateTabClosed(state: InferenceState, tabId: TabId, workspaceId: WorkspaceId, at: number): Detection | undefined {
  if (nearWorkspaceStructure(state, at, workspaceId)) return undefined;
  const exited = near(state, at, INFERENCE.cascadeMs, ["pane_exited"], (e) => e.type === "pane_exited" && state.tabOfPane.get(e.paneId) === tabId);
  return exited ? undefined : { action: "close_tab" };
}

function evaluateTabMoved(state: InferenceState, tabId: TabId, workspaceId: WorkspaceId, newOrder: ReadonlyArray<TabId>): Detection | undefined {
  const from = tabList(state, workspaceId).indexOf(tabId);
  const to = newOrder.indexOf(tabId);
  if (from === -1 || to === -1 || from === to) return undefined;
  return { action: to > from ? "move_tab_next" : "move_tab_previous" };
}

function tabJump(from: number, to: number, count: number): Detection | undefined {
  if (from === -1 || to === -1) return undefined;
  if (count === 2 || to === (from + 1) % count) return { action: "next_tab" };
  if (to === (from - 1 + count) % count) return { action: "previous_tab" };
  return to < 9 ? { action: "switch_tab", index: to + 1 } : undefined;
}

function evaluateTabFocused(state: InferenceState, tabId: TabId, workspaceId: WorkspaceId, at: number): Detection | undefined {
  if (nearTabStructure(state, at, tabId, workspaceId)) return undefined;
  if (near(state, at, INFERENCE.focusSideEffectMs, ["workspace_focused", "tab_moved", "pane_moved"], () => true)) return undefined;
  const previous = state.focusedTabByWorkspace.get(workspaceId);
  if (previous === undefined || previous === tabId) return undefined;
  const tabs = tabList(state, workspaceId);
  return tabJump(tabs.indexOf(previous), tabs.indexOf(tabId), tabs.length);
}

type PaneRef = { readonly paneId: PaneId; readonly tabId: TabId; readonly workspaceId: WorkspaceId };

function splitDirection(layout: TabLayout | undefined, paneId: PaneId, origin: PaneId | undefined): HerdrActionId {
  const created = layout?.panes.find((candidate) => candidate.paneId === paneId)?.rect;
  const from = layout?.panes.find((candidate) => candidate.paneId === origin)?.rect;
  if (created === undefined || from === undefined) return "split_vertical";
  return sharesRow(created, from) ? "split_vertical" : "split_horizontal";
}

function evaluatePaneCreated(state: InferenceState, pane: PaneRef, at: number): Detection | undefined {
  if (nearTabStructure(state, at, pane.tabId, pane.workspaceId)) return undefined;
  if (near(state, at, INFERENCE.cascadeMs, ["pane_moved"], (e) => e.type === "pane_moved" && e.pane.paneId === pane.paneId)) return undefined;
  const layout = laterLayoutFor(state, pane.tabId, at) ?? state.layouts.get(pane.tabId);
  return { action: splitDirection(layout, pane.paneId, state.focusedPaneByTab.get(pane.tabId)) };
}

function evaluatePaneClosed(state: InferenceState, paneId: PaneId, workspaceId: WorkspaceId, at: number): Detection | undefined {
  const tabId = state.tabOfPane.get(paneId);
  if (tabId !== undefined && nearTabStructure(state, at, tabId, workspaceId)) return undefined;
  if (near(state, at, INFERENCE.cascadeMs, ["pane_exited"], (e) => e.type === "pane_exited" && e.paneId === paneId)) return undefined;
  if (near(state, at, INFERENCE.cascadeMs, ["pane_moved"], (e) => e.type === "pane_moved" && e.pane.paneId === paneId)) return undefined;
  return { action: "close_pane" };
}

function evaluatePaneFocused(state: InferenceState, paneId: PaneId, workspaceId: WorkspaceId, at: number): Detection | undefined {
  const tabId = state.tabOfPane.get(paneId);
  if (tabId === undefined || isFocusSideEffect(state, at, tabId, workspaceId)) return undefined;
  const previous = state.focusedPaneByTab.get(tabId);
  if (previous === undefined || previous === paneId) return undefined;
  return { action: focusDirection(state, tabId, previous, paneId) };
}

const FOCUS_SIDE_EFFECT_EVENTS: ReadonlyArray<HerdrEventType> = [
  "tab_focused",
  "workspace_focused",
  "pane_created",
  "pane_closed",
  "pane_moved",
  "pane_exited",
];

function isFocusSideEffect(state: InferenceState, at: number, tabId: TabId, workspaceId: WorkspaceId): boolean {
  return nearTabStructure(state, at, tabId, workspaceId) || near(state, at, INFERENCE.focusSideEffectMs, FOCUS_SIDE_EFFECT_EVENTS, () => true);
}

function focusDirection(state: InferenceState, tabId: TabId, previous: PaneId, next: PaneId): HerdrActionId {
  const layout = state.layouts.get(tabId);
  const from = layout?.panes.find((pane) => pane.paneId === previous)?.rect;
  const to = layout?.panes.find((pane) => pane.paneId === next)?.rect;
  if (from === undefined || to === undefined) return "cycle_pane_next";
  return directionBetween(from, to) ?? "cycle_pane_next";
}

function evaluateLayoutUpdated(state: InferenceState, layout: TabLayout, at: number): Detection | undefined {
  const previous = state.layouts.get(layout.tabId);
  if (previous === undefined) return undefined;
  if (previous.zoomed !== layout.zoomed) return { action: "zoom" };
  if (layout.zoomed || !samePaneSet(previous, layout)) return undefined;
  if (nearTabStructure(state, at, layout.tabId, layout.workspaceId)) return undefined;
  if (laterLayoutFor(state, layout.tabId, at, INFERENCE.resizeBurstMs, true) !== undefined) return undefined;
  const swap = detectSwap(previous, layout);
  if (swap !== undefined) return { action: swap };
  return rectsChanged(previous, layout) ? { action: "resize_mode" } : undefined;
}

function laterLayoutFor(state: InferenceState, tabId: TabId, at: number, windowMs: number = INFERENCE.cascadeMs, strictlyAfter = false): TabLayout | undefined {
  let found: TabLayout | undefined;
  for (const entry of state.recent) {
    const after = strictlyAfter ? entry.at > at : entry.at >= at;
    if (after && entry.at - at <= windowMs && entry.event.type === "layout_updated" && entry.event.layout.tabId === tabId) {
      found = entry.event.layout;
    }
  }
  return found;
}

function apply(state: InferenceState, event: HerdrEvent): void {
  if (event.type.startsWith("workspace_")) applyWorkspaceEvent(state, event);
  else if (event.type.startsWith("tab_")) applyTabEvent(state, event);
  else applyPaneEvent(state, event);
}

function applyWorkspaceEvent(state: InferenceState, event: HerdrEvent): void {
  switch (event.type) {
    case "workspace_created":
      if (!state.workspaces.includes(event.workspace.workspaceId)) state.workspaces.push(event.workspace.workspaceId);
      if (event.workspace.isWorktree) state.worktreeWorkspaces.add(event.workspace.workspaceId);
      state.focusedTabByWorkspace.set(event.workspace.workspaceId, event.workspace.activeTabId);
      return;
    case "workspace_closed":
      removeWorkspace(state, event.workspaceId);
      return;
    case "workspace_moved":
    case "workspace_reordered":
      state.workspaces.length = 0;
      for (const ws of event.workspaces.toSorted((a, b) => a.number - b.number)) state.workspaces.push(ws.workspaceId);
      return;
    case "workspace_focused":
      state.focusedWorkspace = event.workspaceId;
      return;
    default:
      return;
  }
}

function applyTabEvent(state: InferenceState, event: HerdrEvent): void {
  switch (event.type) {
    case "tab_created": {
      const tabs = tabList(state, event.tab.workspaceId);
      if (!tabs.includes(event.tab.tabId)) tabs.splice(Math.max(0, event.tab.number - 1), 0, event.tab.tabId);
      return;
    }
    case "tab_closed": {
      const tabs = tabList(state, event.workspaceId);
      const index = tabs.indexOf(event.tabId);
      if (index !== -1) tabs.splice(index, 1);
      state.layouts.delete(event.tabId);
      state.focusedPaneByTab.delete(event.tabId);
      return;
    }
    case "tab_moved":
      state.tabsByWorkspace.set(event.workspaceId, event.tabs.toSorted((a, b) => a.number - b.number).map((tab) => tab.tabId));
      return;
    case "tab_focused":
      state.focusedTabByWorkspace.set(event.workspaceId, event.tabId);
      return;
    default:
      return;
  }
}

function applyPaneEvent(state: InferenceState, event: HerdrEvent): void {
  switch (event.type) {
    case "pane_created":
    case "pane_moved":
      state.tabOfPane.set(event.pane.paneId, event.pane.tabId);
      return;
    case "pane_focused": {
      const tabId = state.tabOfPane.get(event.paneId);
      if (tabId !== undefined) state.focusedPaneByTab.set(tabId, event.paneId);
      return;
    }
    case "layout_updated":
      state.layouts.set(event.layout.tabId, event.layout);
      state.focusedPaneByTab.set(event.layout.tabId, event.layout.focusedPaneId);
      for (const pane of event.layout.panes) state.tabOfPane.set(pane.paneId, event.layout.tabId);
      return;
    default:
      return;
  }
}

function removeWorkspace(state: InferenceState, workspaceId: WorkspaceId): void {
  const index = state.workspaces.indexOf(workspaceId);
  if (index !== -1) state.workspaces.splice(index, 1);
  state.worktreeWorkspaces.delete(workspaceId);
  for (const tabId of state.tabsByWorkspace.get(workspaceId) ?? []) {
    state.layouts.delete(tabId);
    state.focusedPaneByTab.delete(tabId);
  }
  state.tabsByWorkspace.delete(workspaceId);
  state.focusedTabByWorkspace.delete(workspaceId);
  if (state.focusedWorkspace === workspaceId) state.focusedWorkspace = undefined;
}

const NAVIGATION_ACTIONS: ReadonlySet<HerdrActionId> = new Set<HerdrActionId>([
  "next_tab",
  "previous_tab",
  "switch_tab",
  "focus_pane_left",
  "focus_pane_right",
  "focus_pane_up",
  "focus_pane_down",
  "cycle_pane_next",
  "workspace_picker",
  "next_workspace",
  "previous_workspace",
  "switch_workspace",
]);

function settleDelayFor(event: HerdrEvent): number {
  return event.type === "workspace_focused" ? INFERENCE.workspaceDwellMs + INFERENCE.settleMs : INFERENCE.settleMs;
}

function minGapFor(action: HerdrActionId): number {
  return NAVIGATION_ACTIONS.has(action) ? INFERENCE.navigationMinGapMs : INFERENCE.sameActionMinGapMs;
}

function sharesRow(a: Rect, b: Rect): boolean {
  return a.y === b.y && a.height === b.height;
}

export function directionBetween(from: Rect, to: Rect): HerdrActionId | undefined {
  if (to.x >= from.x + from.width) return "focus_pane_right";
  if (to.x + to.width <= from.x) return "focus_pane_left";
  if (to.y >= from.y + from.height) return "focus_pane_down";
  if (to.y + to.height <= from.y) return "focus_pane_up";
  return undefined;
}

function samePaneSet(a: TabLayout, b: TabLayout): boolean {
  if (a.panes.length !== b.panes.length) return false;
  const ids = new Set(a.panes.map((pane) => pane.paneId));
  return b.panes.every((pane) => ids.has(pane.paneId));
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function rectsChanged(a: TabLayout, b: TabLayout): boolean {
  const before = new Map(a.panes.map((pane) => [pane.paneId, pane.rect]));
  return b.panes.some((pane) => {
    const rect = before.get(pane.paneId);
    return rect === undefined || !sameRect(rect, pane.rect);
  });
}

type SwappedPair = { readonly focused: { readonly paneId: PaneId; readonly rect: Rect }; readonly focusedBefore: Rect };

function swappedPair(previous: TabLayout, next: TabLayout): SwappedPair | undefined {
  const before = new Map(previous.panes.map((pane) => [pane.paneId, pane.rect]));
  const moved = next.panes.filter((pane) => {
    const rect = before.get(pane.paneId);
    return rect !== undefined && !sameRect(rect, pane.rect);
  });
  const [first, second] = moved;
  if (moved.length !== 2 || first === undefined || second === undefined) return undefined;
  const firstBefore = before.get(first.paneId);
  const secondBefore = before.get(second.paneId);
  if (firstBefore === undefined || secondBefore === undefined) return undefined;
  if (!sameRect(first.rect, secondBefore) || !sameRect(second.rect, firstBefore)) return undefined;
  const focused = first.paneId === next.focusedPaneId ? first : second;
  const focusedBefore = focused === first ? firstBefore : secondBefore;
  return { focused, focusedBefore };
}

const SWAP_FOR_DIRECTION: ReadonlyMap<HerdrActionId, HerdrActionId> = new Map([
  ["focus_pane_left", "swap_pane_left"],
  ["focus_pane_right", "swap_pane_right"],
  ["focus_pane_up", "swap_pane_up"],
  ["focus_pane_down", "swap_pane_down"],
]);

function detectSwap(previous: TabLayout, next: TabLayout): HerdrActionId | undefined {
  const pair = swappedPair(previous, next);
  if (pair === undefined) return undefined;
  const direction = directionBetween(pair.focusedBefore, pair.focused.rect);
  return direction === undefined ? undefined : SWAP_FOR_DIRECTION.get(direction);
}
