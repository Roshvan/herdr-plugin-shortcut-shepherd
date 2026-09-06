export type HerdrActionId =
  | "new_tab" | "close_tab" | "next_tab" | "previous_tab" | "switch_tab" | "rename_tab"
  | "move_tab_next" | "move_tab_previous" | "split_vertical" | "split_horizontal" | "close_pane"
  | "focus_pane_left" | "focus_pane_down" | "focus_pane_up" | "focus_pane_right" | "cycle_pane_next"
  | "swap_pane_left" | "swap_pane_down" | "swap_pane_up" | "swap_pane_right" | "zoom" | "resize_mode"
  | "new_workspace" | "close_workspace" | "rename_workspace" | "workspace_picker"
  | "next_workspace" | "previous_workspace" | "switch_workspace";

export type ActionSpec = {
  readonly id: HerdrActionId;
  readonly title: string;
  readonly didWhat: string;
  readonly defaultKeys: ReadonlyArray<string>;
};

const SPECS: ReadonlyArray<ActionSpec> = [
  { id: "new_tab", title: "New tab", didWhat: "opened a new tab", defaultKeys: ["prefix+c"] },
  { id: "close_tab", title: "Close tab", didWhat: "closed a tab", defaultKeys: ["prefix+shift+x"] },
  { id: "next_tab", title: "Next tab", didWhat: "moved to the next tab", defaultKeys: ["prefix+n"] },
  { id: "previous_tab", title: "Previous tab", didWhat: "moved to the previous tab", defaultKeys: ["prefix+p"] },
  { id: "switch_tab", title: "Jump to tab N", didWhat: "jumped to a tab", defaultKeys: ["prefix+1..9"] },
  { id: "rename_tab", title: "Rename tab", didWhat: "renamed a tab", defaultKeys: ["prefix+shift+t"] },
  { id: "move_tab_next", title: "Move tab right", didWhat: "moved a tab toward the back", defaultKeys: [] },
  { id: "move_tab_previous", title: "Move tab left", didWhat: "moved a tab toward the front", defaultKeys: [] },
  { id: "split_vertical", title: "Split right", didWhat: "split the pane to the right", defaultKeys: ["prefix+v"] },
  { id: "split_horizontal", title: "Split down", didWhat: "split the pane downward", defaultKeys: ["prefix+minus"] },
  { id: "close_pane", title: "Close pane", didWhat: "closed a pane", defaultKeys: ["prefix+x"] },
  { id: "focus_pane_left", title: "Focus pane left", didWhat: "focused the pane to the left", defaultKeys: ["prefix+h"] },
  { id: "focus_pane_down", title: "Focus pane below", didWhat: "focused the pane below", defaultKeys: ["prefix+j"] },
  { id: "focus_pane_up", title: "Focus pane above", didWhat: "focused the pane above", defaultKeys: ["prefix+k"] },
  { id: "focus_pane_right", title: "Focus pane right", didWhat: "focused the pane to the right", defaultKeys: ["prefix+l"] },
  { id: "cycle_pane_next", title: "Cycle panes", didWhat: "focused another pane", defaultKeys: ["prefix+tab"] },
  { id: "swap_pane_left", title: "Swap pane left", didWhat: "swapped a pane leftward", defaultKeys: ["prefix+shift+h"] },
  { id: "swap_pane_down", title: "Swap pane down", didWhat: "swapped a pane downward", defaultKeys: ["prefix+shift+j"] },
  { id: "swap_pane_up", title: "Swap pane up", didWhat: "swapped a pane upward", defaultKeys: ["prefix+shift+k"] },
  { id: "swap_pane_right", title: "Swap pane right", didWhat: "swapped a pane rightward", defaultKeys: ["prefix+shift+l"] },
  { id: "zoom", title: "Zoom pane", didWhat: "toggled pane zoom", defaultKeys: ["prefix+z"] },
  { id: "resize_mode", title: "Resize panes", didWhat: "resized a pane", defaultKeys: ["prefix+r"] },
  { id: "new_workspace", title: "New workspace", didWhat: "created a workspace", defaultKeys: ["prefix+shift+n"] },
  { id: "close_workspace", title: "Close workspace", didWhat: "closed a workspace", defaultKeys: ["prefix+shift+d"] },
  { id: "rename_workspace", title: "Rename workspace", didWhat: "renamed a workspace", defaultKeys: ["prefix+shift+w"] },
  { id: "workspace_picker", title: "Workspace picker", didWhat: "switched workspace", defaultKeys: ["prefix+w"] },
  { id: "next_workspace", title: "Next workspace", didWhat: "moved to the next workspace", defaultKeys: [] },
  { id: "previous_workspace", title: "Previous workspace", didWhat: "moved to the previous workspace", defaultKeys: [] },
  { id: "switch_workspace", title: "Jump to workspace N", didWhat: "jumped to a workspace", defaultKeys: [] },
];

const SPEC_BY_ID: ReadonlyMap<HerdrActionId, ActionSpec> = new Map(SPECS.map((spec) => [spec.id, spec]));
const ACTION_IDS: ReadonlySet<string> = new Set(SPECS.map((spec) => spec.id));

export function actionSpec(id: HerdrActionId): ActionSpec {
  const spec = SPEC_BY_ID.get(id);
  if (spec === undefined) throw new Error(`Unknown action spec ${id}`);
  return spec;
}

export function isHerdrActionId(value: string): value is HerdrActionId {
  return ACTION_IDS.has(value);
}

const DEFAULT_PREFIX = "ctrl+b";

export type KeyOverrides = {
  readonly prefix: string | undefined;
  readonly bindings: ReadonlyMap<HerdrActionId, ReadonlyArray<string>>;
};

export type Keymap = {
  readonly prefix: string;
  readonly bindings: ReadonlyMap<HerdrActionId, ReadonlyArray<string>>;
};

export function buildKeymap(overrides: KeyOverrides | undefined): Keymap {
  const bindings = new Map<HerdrActionId, ReadonlyArray<string>>();
  for (const spec of SPECS) bindings.set(spec.id, overrides?.bindings.get(spec.id) ?? spec.defaultKeys);
  return { prefix: overrides?.prefix ?? DEFAULT_PREFIX, bindings };
}

export function bindingsFor(keymap: Keymap, id: HerdrActionId): ReadonlyArray<string> {
  return keymap.bindings.get(id) ?? [];
}

export function formatBinding(keymap: Keymap, binding: string, index?: number): string {
  const indexed = index !== undefined ? binding.replace(/1\.\.9/, String(index)) : binding;
  return indexed.startsWith("prefix+") ? `${keymap.prefix}, ${indexed.slice("prefix+".length)}` : indexed;
}
