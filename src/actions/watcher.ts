import { resolvePluginEnv, type PluginEnv } from "../plugin-env.ts";
import { pluginPaths, type PluginPaths } from "../plugin-files.ts";
import { startWatcher } from "../watcher-process.ts";
import { callWatcher, readControlSecret } from "../watcher-control.ts";
import { isJsonObject, stringField, type JsonObject } from "../json.ts";

/** Parsed context captured once at an action entrypoint. */
export type ActionContext = { readonly env: PluginEnv; readonly paths: PluginPaths; readonly inherited: NodeJS.ProcessEnv };

/** Report an expected action failure at the CLI boundary. */
export function fail(line: string): never { process.stderr.write(`${line}\n`); process.exit(1); }

/** Report a completed action, not merely a requested spawn or file write. */
export function finish(line: string): never { process.stdout.write(`${line}\n`); process.exit(0); }

/** Resolve the current Herdr session or fail without touching any fallback session. */
export function actionContext(): ActionContext {
  const inherited = { ...process.env };
  const env = resolvePluginEnv(inherited);
  if (env._tag === "err") fail(env.error.message);
  return { env: env.value, paths: pluginPaths(env.value), inherited };
}

/** Wait for a ready watcher before an operation that requires one. */
export async function ensureWatcher(context: ActionContext): Promise<string> {
  const result = await startWatcher(context.env, context.paths, context.inherited);
  if (result._tag === "err") fail(result.error.message);
  return result.value;
}

/** Route mutations through the sole writer, waiting for their committed acknowledgment. */
export async function invokeWatcher(context: ActionContext, method: string, args: JsonObject = {}): Promise<string> {
  await ensureWatcher(context);
  const secret = await readControlSecret(context.paths);
  if (secret._tag === "err") fail(secret.error.message);
  if (secret.value === undefined) fail("Watcher control key disappeared");
  const result = await callWatcher(context.paths, secret.value, method, args);
  if (result._tag === "err") fail(result.error.message);
  return isJsonObject(result.value) ? stringField(result.value, "message") ?? "Command completed." : "Command completed.";
}
