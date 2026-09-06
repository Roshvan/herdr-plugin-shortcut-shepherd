import { ok, err, type Result } from "./result.ts";
import { isHerdrActionId, type HerdrActionId } from "./keymap.ts";
import { isBoolean, isJsonArray, isJsonObject, isString, type JsonObject, type JsonValue } from "./json.ts";

type ToastPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type PluginConfig = {
  readonly enabled: boolean;
  readonly inputMonitoring: "off" | "local-estimate";
  readonly position: ToastPosition;
  readonly suppressed: ReadonlySet<HerdrActionId>;
};

const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  inputMonitoring: "local-estimate",
  position: "bottom-right",
  suppressed: new Set(),
};

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

export function parseConfig(value: JsonValue | undefined): Result<PluginConfig, InvalidConfig> {
  if (value === undefined) return ok(DEFAULT_CONFIG);
  if (!isJsonObject(value)) return err(invalidConfig("root"));
  const enabled = readEnabled(value);
  if (enabled._tag === "err") return enabled;
  const position = readPosition(value);
  if (position._tag === "err") return position;
  const suppressed = readSuppressed(value);
  if (suppressed._tag === "err") return suppressed;
  const inputMonitoring = value["inputMonitoring"] === undefined ? DEFAULT_CONFIG.inputMonitoring : value["inputMonitoring"];
  if (inputMonitoring !== "off" && inputMonitoring !== "local-estimate") return err(invalidConfig("inputMonitoring"));
  return ok({ enabled: enabled.value, inputMonitoring, position: position.value, suppressed: suppressed.value });
}

export function configToJson(config: PluginConfig) {
  return {
    enabled: config.enabled,
    inputMonitoring: config.inputMonitoring,
    position: config.position,
    suppressed: [...config.suppressed].toSorted(),
  };
}
