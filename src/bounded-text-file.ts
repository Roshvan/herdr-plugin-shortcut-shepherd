import { open, type FileHandle } from "node:fs/promises";
import { err, ok, type Result } from "./result.ts";

/** A read/encoding/size failure without file contents in diagnostics. */
export type TextFileUnreadable = { readonly _tag: "TextFileUnreadable"; readonly message: string; readonly path: string; readonly cause: unknown };

/** Read optional UTF-8 text with a fixed memory bound, even if the file grows during the read. */
export async function readTextFile(path: string, maxBytes = 1024 * 1024): Promise<Result<string | undefined, TextFileUnreadable>> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return err({ _tag: "TextFileUnreadable", message: `${path} exceeds the ${maxBytes}-byte limit`, path, cause: undefined });
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return ok(undefined);
    return err({ _tag: "TextFileUnreadable", message: `Cannot read UTF-8 file ${path}`, path, cause });
  } finally { await handle?.close().catch(() => undefined); }
}
