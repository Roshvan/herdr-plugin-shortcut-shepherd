import { ok, err, type Result } from "./result.ts";

export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

export type InvalidJson = { readonly _tag: "InvalidJson"; readonly message: string; readonly source: string };

function invalidJson(source: string): InvalidJson {
  return { _tag: "InvalidJson", message: `${source} is not valid JSON`, source };
}

export function parseJsonText(source: string, text: string): Result<JsonValue, InvalidJson> {
  try {
    const value: JsonValue = JSON.parse(text);
    return ok(value);
  } catch {
    return err(invalidJson(source));
  }
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is ReadonlyArray<JsonValue> {
  return Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

export function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function stringField(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return isString(value) ? value : undefined;
}

export function numberField(obj: JsonObject, key: string): number | undefined {
  const value = obj[key];
  return isFiniteNumber(value) ? value : undefined;
}
