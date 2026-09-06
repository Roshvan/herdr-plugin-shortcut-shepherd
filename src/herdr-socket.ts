import { createConnection, type Socket } from "node:net";
import { isJsonObject, isString, parseJsonText, type JsonObject, type JsonValue } from "./json.ts";
import { ok, err, type Result } from "./result.ts";

/** Herdr Unix/named-pipe address or a plugin-private loopback control endpoint. */
export type SocketTarget = string | { readonly host: "127.0.0.1"; readonly port: number };

/** Known socket, protocol, cancellation, or deadline failure. */
export type SocketFailure = { readonly _tag: "SocketFailure"; readonly message: string; readonly code: string };

/** Per-operation limits; cancellation also closes an established subscription. */
export type SocketOptions = { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly maxLineBytes?: number; readonly maxQueueBytes?: number; readonly errorDetails?: "redacted" | "message" };

/** A bounded stream whose expected failures are values rather than iterator rejections. */
export type SocketLines = {
  readonly next: (timeoutMs?: number) => Promise<Result<string | undefined, SocketFailure>>;
  readonly close: () => void;
};

const DEFAULT_TIMEOUT_MS = 5000;

function failure(code: string, detail: string): SocketFailure {
  return { _tag: "SocketFailure", code, message: `${code}: ${detail}` };
}

function errorCode(cause: Error): string {
  return "code" in cause && isString(cause.code) ? cause.code : "SOCKET_ERROR";
}

type LineResult = Result<string | undefined, SocketFailure>;
type PendingRead = { readonly resolve: (value: LineResult) => void; readonly timer: ReturnType<typeof setTimeout> | undefined };

function readLines(socket: Socket, options: SocketOptions): SocketLines {
  const queue: string[] = [];
  let queuedBytes = 0;
  let buffer = "";
  let ended: LineResult | undefined;
  let pending: PendingRead | undefined;
  const deliver = (value: LineResult) => {
    const waiting = pending;
    pending = undefined;
    if (waiting !== undefined) { clearTimeout(waiting.timer); waiting.resolve(value); }
  };
  const finish = (value: LineResult) => {
    if (ended !== undefined) return;
    ended = value;
    options.signal?.removeEventListener("abort", abort);
    if (value._tag === "err") { queue.length = 0; queuedBytes = 0; }
    if (queue.length === 0) deliver(value);
    socket.destroy();
  };
  const abort = () => finish(err(failure("ABORTED", "socket operation cancelled")));
  const push = (line: string) => {
    if (pending !== undefined) { deliver(ok(line)); return; }
    queuedBytes += Buffer.byteLength(line);
    if (queuedBytes > (options.maxQueueBytes ?? 4 * 1024 * 1024)) {
      finish(err(failure("BUFFER_LIMIT", "subscription backlog exceeded its byte limit")));
    } else queue.push(line);
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > (options.maxLineBytes ?? 1024 * 1024)) finish(err(failure("BUFFER_LIMIT", "socket line too large")));
      else push(line);
      if (ended !== undefined) break;
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer) > (options.maxLineBytes ?? 1024 * 1024)) finish(err(failure("BUFFER_LIMIT", "socket line too large")));
  });
  socket.on("error", (cause) => finish(err(failure(errorCode(cause), "socket connection failed"))));
  socket.once("close", () => finish(buffer === "" ? ok(undefined) : err(failure("TRUNCATED", "connection closed in the middle of a line"))));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    next: (timeoutMs) => {
      const line = queue.shift();
      if (line !== undefined) { queuedBytes -= Buffer.byteLength(line); return Promise.resolve(ok(line)); }
      if (ended !== undefined) return Promise.resolve(ended);
      if (pending !== undefined) return Promise.resolve(err(failure("CONCURRENT_READ", "only one stream reader is permitted")));
      return new Promise((resolve) => {
        const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(err(failure("TIMEOUT", "socket response deadline exceeded"))), timeoutMs);
        pending = { resolve, timer };
      });
    },
    close: () => finish(ok(undefined)),
  };
}

type Connection = { readonly socket: Socket; readonly lines: SocketLines };

async function connect(target: SocketTarget, options: SocketOptions): Promise<Result<Connection, SocketFailure>> {
  if (options.signal?.aborted) return err(failure("ABORTED", "socket operation cancelled"));
  return new Promise((resolve) => {
    const socket = isString(target) ? createConnection(target) : createConnection(target);
    const lines = readLines(socket, options);
    const timer = setTimeout(() => { lines.close(); resolve(err(failure("TIMEOUT", "socket connect deadline exceeded"))); }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const finish = (result: Result<Connection, SocketFailure>) => { clearTimeout(timer); resolve(result); };
    socket.once("connect", () => finish(ok({ socket, lines })));
    socket.once("error", (cause) => finish(err(failure(errorCode(cause), "could not connect to socket"))));
    socket.once("close", () => finish(err(failure("CLOSED", "socket closed before connecting"))));
  });
}

function parseResponse(method: string, line: string | undefined, options: SocketOptions): Result<JsonValue, SocketFailure> {
  if (line === undefined) return err(failure("CLOSED", `${method}: connection closed before response`));
  const parsed = parseJsonText(method, line);
  if (parsed._tag === "err" || !isJsonObject(parsed.value)) return err(failure("PROTOCOL", `${method}: response must be a JSON object`));
  if (parsed.value["error"] !== undefined) {
    // Only the private watcher protocol opts into its application-owned error messages.
    const remote = parsed.value["error"];
    const message = isJsonObject(remote) ? remote["message"] : undefined;
    const detail = options.errorDetails === "message" && isString(message) ? message.slice(0, 1000) : `${method}: server rejected the request`;
    return err(failure("REMOTE_ERROR", detail));
  }
  const value = parsed.value["result"];
  return value === undefined ? err(failure("PROTOCOL", `${method}: missing result`)) : ok(value);
}

/** Send a bounded JSON request and always close its owned connection. */
export async function requestOnce(target: SocketTarget, method: string, params: JsonObject, options: SocketOptions = {}): Promise<Result<JsonValue, SocketFailure>> {
  const connection = await connect(target, options);
  if (connection._tag === "err") return connection;
  const { socket, lines } = connection.value;
  try {
    socket.write(`${JSON.stringify({ id: "shepherd", method, params })}\n`);
    const line = await lines.next(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return line._tag === "err" ? line : parseResponse(method, line.value, options);
  } finally { lines.close(); }
}

/** Subscribe with a bounded handshake and backlog, leaving idle streams open until explicitly closed. */
export async function openEventStream(target: SocketTarget, eventNames: ReadonlyArray<string>, options: SocketOptions = {}): Promise<Result<SocketLines, SocketFailure>> {
  const connection = await connect(target, options);
  if (connection._tag === "err") return connection;
  const { socket, lines } = connection.value;
  socket.write(`${JSON.stringify({ id: "shepherd-events", method: "events.subscribe", params: { subscriptions: eventNames.map((type) => ({ type })) } })}\n`);
  const line = await lines.next(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const ack = line._tag === "err" ? line : parseResponse("events.subscribe", line.value, options);
  if (ack._tag === "err") { lines.close(); return ack; }
  return ok(lines);
}
