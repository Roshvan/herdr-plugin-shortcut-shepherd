import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ok, err, type Result } from "./result.ts";
import { parseJsonText, type JsonValue } from "./json.ts";
import { readTextFile } from "./bounded-text-file.ts";

export type JsonFileUnreadable = { readonly _tag: "JsonFileUnreadable"; readonly message: string; readonly path: string; readonly cause: unknown };

export type JsonFileUnwritable = { readonly _tag: "JsonFileUnwritable"; readonly message: string; readonly path: string; readonly cause: unknown };

export async function readJsonFile(path: string): Promise<Result<JsonValue | undefined, JsonFileUnreadable>> {
  const text = await readTextFile(path);
  if (text._tag === "err") return err({ _tag: "JsonFileUnreadable", message: text.error.message, path, cause: text.error });
  if (text.value === undefined) return ok(undefined);
  const parsed = parseJsonText(path, text.value);
  return parsed._tag === "ok" ? parsed : err({ _tag: "JsonFileUnreadable", message: `Invalid JSON in ${path}; original preserved`, path, cause: parsed.error });
}

export async function writeJsonFileAtomic(path: string, value: JsonValue): Promise<Result<void, JsonFileUnwritable>> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, path);
    return ok(undefined);
  } catch (cause) {
    return err({ _tag: "JsonFileUnwritable", message: `Could not write JSON file ${path}`, path, cause });
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
