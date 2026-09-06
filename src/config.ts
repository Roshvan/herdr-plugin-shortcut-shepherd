import { ok, err, type Result } from "./result.ts";
import { isHerdrActionId, type HerdrActionId } from "./keymap.ts";
import { isBoolean, isJsonArray, isJsonObject, isString, type JsonObject, type JsonValue } from "./json.ts";

/** Herdr-supported notification placement. */
export type ToastPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** User-editable settings. Monitoring is opt-in because server-local input is not client input. */
export type PluginConfig = {
  readonly enabled: boolean;
  readonly inputMonitoring: "off" | "local-estimate";
  readonly position: ToastPosition;
  readonly suppressed: ReadonlySet<HerdrActionId>;
};

/** Safe defaults: input monitoring is off and unknown actions never nudge. */
export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  inputMonitoring: "off",
  position: "bottom-right",
  suppressed: new Set(),
};

/** A specific configuration field cannot be interpreted safely. */
export type InvalidConfig = { readonly _tag: "InvalidConfig"; readonly message: string; readonly field: string };

function invalidConfig(field: string): InvalidConfig {
  return { _tag: "InvalidConfig", message: `config.json field ${field} is invalid`, field };
}

const POSITIONS: ReadonlyArray<ToastPosition> = ["top-left", "top-right", "bottom-left", "bottom-right"];

function readEnabled(obj: JsonObject): Result<boolean, InvalidConfig> {
  const value = obj["enabled"];
  if (value === undefined) return ok(DEFAULT_CONFIG.enabled);
  return isBoolean(value) ? ok(value) : err(invalidConfig("enabled"));
}

function readPosition(obj: JsonObject): Result<ToastPosition, InvalidConfig> {
  const value = obj["position"];
  if (value === undefined) return ok(DEFAULT_CONFIG.position);
  const match = POSITIONS.find((candidate) => candidate === value);
  return match !== undefined ? ok(match) : err(invalidConfig("position"));
}

function readSuppressed(obj: JsonObject): Result<ReadonlySet<HerdrActionId>, InvalidConfig> {
  const value = obj["suppressed"];
  if (value === undefined) return ok(new Set());
  if (!isJsonArray(value)) return err(invalidConfig("suppressed"));
  const out = new Set<HerdrActionId>();
  for (const item of value) {
    if (!isString(item)) return err(invalidConfig("suppressed"));
    if (isHerdrActionId(item)) out.add(item);
  }
  return ok(out);
}

/** Parse shared settings, retaining explicit off/unknown attribution semantics. */
export function parseConfig(value: JsonValue | undefined): Result<PluginConfig, InvalidConfig> {
  if (value === undefined || value === null) return ok(DEFAULT_CONFIG);
  if (!isJsonObject(value)) return err(invalidConfig("root"));
  const enabled = readEnabled(value);
  if (enabled._tag === "err") return enabled;
  const position = readPosition(value);
  if (position._tag === "err") return position;
  const suppressed = readSuppressed(value);
  if (suppressed._tag === "err") return suppressed;
  const inputMonitoring = value["inputMonitoring"] ?? "off";
  if (inputMonitoring !== "off" && inputMonitoring !== "local-estimate") return err(invalidConfig("inputMonitoring"));
  return ok({ enabled: enabled.value, inputMonitoring, position: position.value, suppressed: suppressed.value });
}

/** Serialize shared settings for display/status without runtime handles. */
export function configToJson(config: PluginConfig) {
  return {
    enabled: config.enabled,
    inputMonitoring: config.inputMonitoring,
    position: config.position,
    suppressed: [...config.suppressed].toSorted(),
  };
}

/** Purely toggle a shared suppression when constructing edited configuration. */
export function toggleSuppressed(config: PluginConfig, id: HerdrActionId): PluginConfig {
  const suppressed = new Set(config.suppressed);
  if (suppressed.has(id)) suppressed.delete(id);
  else suppressed.add(id);
  return { ...config, suppressed };
}
