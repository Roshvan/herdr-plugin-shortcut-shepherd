import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";
import { buildKeymap, isHerdrActionId, type HerdrActionId, type Keymap, type KeyOverrides } from "./keymap.ts";
import { isJsonArray, isJsonObject, isString, parseJsonText, type JsonValue } from "./json.ts";
import { ok, err, type Result } from "./result.ts";
import { readTextFile } from "./bounded-text-file.ts";

export type KeymapUnavailable = { readonly _tag: "KeymapUnavailable"; readonly message: string };

function unavailable(detail: string): KeymapUnavailable {
  return { _tag: "KeymapUnavailable", message: `Herdr keybindings unavailable: ${detail}` };
}

export function locateHerdrConfig(override: string | undefined, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (override !== undefined) return override;
  const xdgConfigHome = env["XDG_CONFIG_HOME"];
  if (xdgConfigHome !== undefined) return join(xdgConfigHome, "herdr", "config.toml");
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData !== undefined) return join(appData, "herdr", "config.toml");
    const profile = env["USERPROFILE"];
    if (profile !== undefined) return join(profile, "AppData", "Roaming", "herdr", "config.toml");
  }
  const home = env["HOME"];
  return home !== undefined ? join(home, ".config", "herdr", "config.toml") : join(tmpdir(), "herdr", "config.toml");
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function parsePrefix(value: JsonValue | undefined): Result<string | undefined, KeymapUnavailable> {
  if (value === undefined) return ok(undefined);
  return isString(value) && value.trim() !== "" && !hasControlCharacters(value)
    ? ok(value) : err(unavailable("keys.prefix must be a nonempty string without control characters"));
}

function parseBindings(value: JsonValue): ReadonlyArray<string> | undefined {
  const values = isString(value) ? [value] : value;
  if (!isJsonArray(values)) return undefined;
  const out: string[] = [];
  for (const binding of values) {
    if (!isString(binding) || hasControlCharacters(binding)) return undefined;
    if (binding !== "") out.push(binding);
  }
  return out;
}

function projectKeys(value: JsonValue): Result<KeyOverrides, KeymapUnavailable> {
  if (!isJsonObject(value)) return err(unavailable("root must be a table"));
  const keys = value["keys"] ?? {};
  if (!isJsonObject(keys)) return err(unavailable("keys must be a table"));
  if (keys["indexed"] !== undefined) return err(unavailable("[keys.indexed] is unsupported; use explicit keys.switch_tab and keys.switch_workspace binding strings or string arrays"));
  const bindings = new Map<HerdrActionId, ReadonlyArray<string>>();
  for (const [id, raw] of Object.entries(keys)) {
    if (!isHerdrActionId(id)) continue;
    const parsed = parseBindings(raw);
    if (parsed === undefined) return err(unavailable(`keys.${id} must be a binding string or string array`));
    bindings.set(id, parsed);
  }
  const prefix = parsePrefix(keys["prefix"]);
  return prefix._tag === "err" ? prefix : ok({ prefix: prefix.value, bindings });
}

function parseKeyOverrides(toml: string): Result<KeyOverrides, KeymapUnavailable> {
  try {
    const projected = parseJsonText("Herdr TOML projection", JSON.stringify(parseToml(toml)));
    return projected._tag === "err" ? err(unavailable("TOML could not be projected")) : projectKeys(projected.value);
  } catch (cause) {
    const location = cause instanceof TomlError ? ` at line ${cause.line}, column ${cause.column}` : "";
    return err(unavailable(`invalid TOML${location}`));
  }
}

export type LoadedKeymap = { readonly keymap: Keymap; readonly fingerprint: string };

export async function loadKeymap(path: string): Promise<Result<LoadedKeymap, KeymapUnavailable>> {
  const read = await readTextFile(path);
  if (read._tag === "err") return err(unavailable(read.error.message));
  const text = read.value ?? "";
  const parsed = parseKeyOverrides(text);
  return parsed._tag === "err" ? parsed : ok({
    keymap: buildKeymap(parsed.value),
    fingerprint: createHash("sha256").update(text).digest("hex"),
  });
}
