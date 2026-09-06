import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { isJsonObject, parseJsonText, stringField, type JsonObject, type JsonValue } from "./json.ts";
import { requestOnce } from "./herdr-socket.ts";
import type { PluginPaths } from "./plugin-files.ts";
import { ok, err, type Result } from "./result.ts";
import { readTextFile } from "./bounded-text-file.ts";

/** Private control failures never include the authentication secret. */
export type WatcherUnavailable = { readonly _tag: "WatcherUnavailable"; readonly message: string; readonly code: string };

/** A private value whose printable/JSON representation is always redacted. */
export type ControlSecret = { readonly reveal: () => string; readonly toJSON: () => string; readonly toString: () => string };

/** An application handler receives only authenticated, session-matched commands. */
export type ControlHandler = (method: string, args: JsonObject) => Promise<Result<JsonValue, { readonly _tag: string; readonly message: string }>>;

/** Kernel-held exclusive ownership of a session's control port. */
export type ControlServer = { readonly close: () => void };

function failed(code: string, message: string): WatcherUnavailable {
  return { _tag: "WatcherUnavailable", code, message };
}

function secretValue(value: string): ControlSecret {
  return { reveal: () => value, toJSON: () => "[REDACTED]", toString: () => "[REDACTED]" };
}

/** Read a published secret. A missing file means this session has not started yet. */
export async function readControlSecret(paths: PluginPaths): Promise<Result<ControlSecret | undefined, WatcherUnavailable>> {
  const read = await readTextFile(paths.secret, 64);
  if (read._tag === "err") return err(failed("SECRET_UNREADABLE", read.error.message));
  if (read.value === undefined) return ok(undefined);
  if (!/^[a-f0-9]{64}$/u.test(read.value)) return err(failed("SECRET_INVALID", `Invalid control key at ${paths.secret}; do not overwrite it while a watcher is running`));
  return ok(secretValue(read.value));
}

/** Publish a complete private key with a hard-link create-if-absent operation, safe under concurrent starts. */
export async function ensureControlSecret(paths: PluginPaths): Promise<Result<ControlSecret, WatcherUnavailable>> {
  const temp = `${paths.secret}.${randomUUID()}.tmp`;
  try {
    await mkdir(paths.sessionDir, { recursive: true, mode: 0o700 });
    await writeFile(temp, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    try { await link(temp, paths.secret); }
    catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) return err(failed("SECRET_UNWRITABLE", `Cannot publish ${paths.secret}`));
    }
    const loaded = await readControlSecret(paths);
    if (loaded._tag === "err") return loaded;
    return loaded.value === undefined ? err(failed("SECRET_MISSING", "Control key disappeared during startup")) : ok(loaded.value);
  } catch {
    return err(failed("SECRET_UNWRITABLE", `Cannot create private control key in ${paths.sessionDir}`));
  } finally { await rm(temp, { force: true }).catch(() => undefined); }
}

function authorized(params: JsonObject, paths: PluginPaths, secret: ControlSecret): boolean {
  const token = stringField(params, "token");
  if (token === undefined || !/^[a-f0-9]{64}$/u.test(token) || params["sessionId"] !== paths.sessionId) return false;
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(secret.reveal(), "hex"));
}

async function respond(socket: Socket, line: string, paths: PluginPaths, secret: ControlSecret, handle: ControlHandler): Promise<void> {
  const parsed = parseJsonText("watcher command", line);
  const body = parsed._tag === "ok" ? parsed.value : undefined;
  const params = isJsonObject(body) ? body["params"] : undefined;
  if (!isJsonObject(body) || !isJsonObject(params) || !authorized(params, paths, secret)) {
    socket.end(`${JSON.stringify({ error: { message: "Unauthorized control request" } })}\n`);
    return;
  }
  const method = stringField(body, "method");
  const args = params["args"];
  if (method === undefined || !isJsonObject(args)) { socket.end('{"error":{"message":"Invalid command"}}\n'); return; }
  const result = await handle(method, args);
  const response = result._tag === "ok" ? { result: result.value } : { error: { message: result.error.message } };
  socket.end(`${JSON.stringify(response)}\n`);
}

function accept(socket: Socket, paths: PluginPaths, secret: ControlSecret, handle: ControlHandler): void {
  let buffer = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.setTimeout(30000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 16 * 1024) { socket.destroy(); return; }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    void respond(socket, buffer.slice(0, newline), paths, secret, handle).catch(() => {
      // A handler rejection is a defect, not an expected command failure.
      socket.end('{"error":{"message":"Internal watcher defect"}}\n');
    });
  });
}

/** Acquire exclusive OS ownership; collisions fail closed and are never treated as another process to kill. */
export function serveControl(paths: PluginPaths, secret: ControlSecret, handle: ControlHandler): Promise<Result<ControlServer, WatcherUnavailable>> {
  return new Promise((resolve) => {
    const server = createServer((socket) => accept(socket, paths, secret, handle));
    server.maxConnections = 16;
    server.on("error", () => resolve(err(failed("PORT_UNAVAILABLE", `Session control port ${paths.controlPort} is unavailable; another watcher or application may own it`))));
    server.listen({ host: "127.0.0.1", port: paths.controlPort, exclusive: true }, () => resolve(ok({ close: () => { server.close(); } })));
  });
}

/** Send one authenticated command to this exact session; caller retries must respect command idempotency. */
export async function callWatcher(paths: PluginPaths, secret: ControlSecret, method: string, args: JsonObject = {}): Promise<Result<JsonValue, WatcherUnavailable>> {
  const response = await requestOnce({ host: "127.0.0.1", port: paths.controlPort }, method, { sessionId: paths.sessionId, token: secret.reveal(), args }, { timeoutMs: 15000, errorDetails: "message" });
  if (response._tag === "err") return err(failed(response.error.code, response.error.message));
  return ok(response.value);
}

/** Inspect an authenticated watcher; only an absent secret or refused connection means stopped. */
export async function watcherStatus(paths: PluginPaths): Promise<Result<JsonObject | undefined, WatcherUnavailable>> {
  const secret = await readControlSecret(paths);
  if (secret._tag === "err") return secret;
  if (secret.value === undefined) return ok(undefined);
  const response = await callWatcher(paths, secret.value, "status");
  if (response._tag === "err") return response.error.code === "ECONNREFUSED" ? ok(undefined) : response;
  if (!isJsonObject(response.value) || response.value["sessionId"] !== paths.sessionId) return err(failed("IDENTITY_MISMATCH", "Control endpoint did not identify this session"));
  return ok(response.value);
}
