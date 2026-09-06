/** Built-in Herdr actions for which lifecycle events can suggest an equivalent shortcut. */
export type HerdrActionId =
  | "new_tab" | "close_tab" | "next_tab" | "previous_tab" | "switch_tab" | "rename_tab"
  | "move_tab_next" | "move_tab_previous" | "split_vertical" | "split_horizontal" | "close_pane"
  | "focus_pane_left" | "focus_pane_down" | "focus_pane_up" | "focus_pane_right" | "cycle_pane_next"
  | "swap_pane_left" | "swap_pane_down" | "swap_pane_up" | "swap_pane_right" | "zoom" | "resize_mode"
  | "new_workspace" | "close_workspace" | "rename_workspace" | "workspace_picker"
  | "next_workspace" | "previous_workspace" | "switch_workspace";

/** Display meaning and defaults for one action. */
export type ActionSpec = {
  readonly id: HerdrActionId;
  readonly title: string;
  readonly didWhat: string;
  readonly defaultKeys: ReadonlyArray<string>;
  readonly indexed: boolean;
};

const SPECS: ReadonlyArray<ActionSpec> = [
  { id: "new_tab", title: "New tab", didWhat: "opened a new tab", defaultKeys: ["prefix+c"], indexed: false },
  { id: "close_tab", title: "Close tab", didWhat: "closed a tab", defaultKeys: ["prefix+shift+x"], indexed: false },
  { id: "next_tab", title: "Next tab", didWhat: "moved to the next tab", defaultKeys: ["prefix+n"], indexed: false },
  { id: "previous_tab", title: "Previous tab", didWhat: "moved to the previous tab", defaultKeys: ["prefix+p"], indexed: false },
  { id: "switch_tab", title: "Jump to tab N", didWhat: "jumped to a tab", defaultKeys: ["prefix+1..9"], indexed: true },
  { id: "rename_tab", title: "Rename tab", didWhat: "renamed a tab", defaultKeys: ["prefix+shift+t"], indexed: false },
  { id: "move_tab_next", title: "Move tab right", didWhat: "moved a tab toward the back", defaultKeys: [], indexed: false },
  { id: "move_tab_previous", title: "Move tab left", didWhat: "moved a tab toward the front", defaultKeys: [], indexed: false },
  { id: "split_vertical", title: "Split right", didWhat: "split the pane to the right", defaultKeys: ["prefix+v"], indexed: false },
  { id: "split_horizontal", title: "Split down", didWhat: "split the pane downward", defaultKeys: ["prefix+minus"], indexed: false },
  { id: "close_pane", title: "Close pane", didWhat: "closed a pane", defaultKeys: ["prefix+x"], indexed: false },
  { id: "focus_pane_left", title: "Focus pane left", didWhat: "focused the pane to the left", defaultKeys: ["prefix+h"], indexed: false },
  { id: "focus_pane_down", title: "Focus pane below", didWhat: "focused the pane below", defaultKeys: ["prefix+j"], indexed: false },
  { id: "focus_pane_up", title: "Focus pane above", didWhat: "focused the pane above", defaultKeys: ["prefix+k"], indexed: false },
  { id: "focus_pane_right", title: "Focus pane right", didWhat: "focused the pane to the right", defaultKeys: ["prefix+l"], indexed: false },
  { id: "cycle_pane_next", title: "Cycle panes", didWhat: "focused another pane", defaultKeys: ["prefix+tab"], indexed: false },
  { id: "swap_pane_left", title: "Swap pane left", didWhat: "swapped a pane leftward", defaultKeys: ["prefix+shift+h"], indexed: false },
  { id: "swap_pane_down", title: "Swap pane down", didWhat: "swapped a pane downward", defaultKeys: ["prefix+shift+j"], indexed: false },
  { id: "swap_pane_up", title: "Swap pane up", didWhat: "swapped a pane upward", defaultKeys: ["prefix+shift+k"], indexed: false },
  { id: "swap_pane_right", title: "Swap pane right", didWhat: "swapped a pane rightward", defaultKeys: ["prefix+shift+l"], indexed: false },
  { id: "zoom", title: "Zoom pane", didWhat: "toggled pane zoom", defaultKeys: ["prefix+z"], indexed: false },
  { id: "resize_mode", title: "Resize panes", didWhat: "resized a pane", defaultKeys: ["prefix+r"], indexed: false },
  { id: "new_workspace", title: "New workspace", didWhat: "created a workspace", defaultKeys: ["prefix+shift+n"], indexed: false },
  { id: "close_workspace", title: "Close workspace", didWhat: "closed a workspace", defaultKeys: ["prefix+shift+d"], indexed: false },
  { id: "rename_workspace", title: "Rename workspace", didWhat: "renamed a workspace", defaultKeys: ["prefix+shift+w"], indexed: false },
  { id: "workspace_picker", title: "Workspace picker", didWhat: "switched workspace", defaultKeys: ["prefix+w"], indexed: false },
  { id: "next_workspace", title: "Next workspace", didWhat: "moved to the next workspace", defaultKeys: [], indexed: false },
  { id: "previous_workspace", title: "Previous workspace", didWhat: "moved to the previous workspace", defaultKeys: [], indexed: false },
  { id: "switch_workspace", title: "Jump to workspace N", didWhat: "jumped to a workspace", defaultKeys: [], indexed: true },
];

const SPEC_BY_ID: ReadonlyMap<HerdrActionId, ActionSpec> = new Map(SPECS.map((spec) => [spec.id, spec]));
const ACTION_IDS: ReadonlySet<string> = new Set(SPECS.map((spec) => spec.id));

/** Look up the meaning of a parsed action ID. */
export function actionSpec(id: HerdrActionId): ActionSpec {
  const spec = SPEC_BY_ID.get(id);
  if (spec === undefined) throw new Error(`Unknown action spec ${id}`);
  return spec;
}

/** Refine an external action name to a supported ID. */
export function isHerdrActionId(value: string): value is HerdrActionId {
  return ACTION_IDS.has(value);
}

/** Herdr 0.8's default prefix. */
export const DEFAULT_PREFIX = "ctrl+b";

/** Parsed overrides, including explicit empty arrays for unbound actions. */
export type KeyOverrides = {
  readonly prefix: string | undefined;
  readonly bindings: ReadonlyMap<HerdrActionId, ReadonlyArray<string>>;
};

/** Configured equivalent shortcuts, not proof of runtime invocation. */
export type Keymap = {
  readonly prefix: string;
  readonly bindings: ReadonlyMap<HerdrActionId, ReadonlyArray<string>>;
};

/** Apply parsed overrides to documented Herdr defaults. */
export function buildKeymap(overrides: KeyOverrides | undefined): Keymap {
  const bindings = new Map<HerdrActionId, ReadonlyArray<string>>();
  for (const spec of SPECS) bindings.set(spec.id, overrides?.bindings.get(spec.id) ?? spec.defaultKeys);
  return { prefix: overrides?.prefix ?? DEFAULT_PREFIX, bindings };
}

/** Return all configured equivalents for an action. */
export function bindingsFor(keymap: Keymap, id: HerdrActionId): ReadonlyArray<string> {
  return keymap.bindings.get(id) ?? [];
}

/** Render an indexed binding with the configured prefix expanded. */
export function formatBinding(keymap: Keymap, binding: string, index?: number): string {
  const indexed = index !== undefined ? binding.replace(/1\.\.9/, String(index)) : binding;
  return indexed.startsWith("prefix+") ? `${keymap.prefix}, ${indexed.slice("prefix+".length)}` : indexed;
}
