import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile, writeJsonFileAtomic, type JsonFileUnreadable, type JsonFileUnwritable } from "./json-file.ts";
import { controlToJson, parseControl, parseStats, statsToJson, type Control, type InvalidStateFile, type Stats } from "./nudge-policy.ts";
import type { PluginEnv } from "./plugin-env.ts";
import { err, ok, type Result } from "./result.ts";
import { parseConfig, type InvalidConfig, type PluginConfig } from "./config.ts";

/** Shared read-only settings and session-local mutable state. */
export type PluginPaths = {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly controlPort: number;
  readonly secret: string;
  readonly config: string;
  readonly control: string;
  readonly stats: string;
  readonly log: string;
};

/** Derive stable per-session paths and an exclusive kernel-owned loopback endpoint. */
export function pluginPaths(env: PluginEnv): PluginPaths {
  const digest = createHash("sha256").update(`${env.pluginId}\0${env.stateDir}\0${env.socketPath}`).digest("hex");
  const sessionId = digest.slice(0, 24);
  const sessionDir = join(env.stateDir, "sessions", sessionId);
  return {
    sessionId, sessionDir,
    controlPort: 20000 + Number.parseInt(digest.slice(0, 8), 16) % 40000,
    secret: join(sessionDir, "control.key"),
    config: join(env.configDir, "config.json"),
    control: join(sessionDir, "control.json"),
    stats: join(sessionDir, "stats.json"),
    log: join(sessionDir, "shepherd.log"),
  };
}

/** Seed settings without racing an existing config or swallowing permission errors. */
export async function seedConfigFromExample(paths: PluginPaths, pluginRoot: string): Promise<Result<void, JsonFileUnwritable>> {
  const temp = `${paths.config}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
    try { await lstat(paths.config); return ok(undefined); }
    catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause; }
    await copyFile(join(pluginRoot, "config.example.json"), temp, constants.COPYFILE_EXCL);
    // Publish a complete file; another session must never read a partly seeded config.
    try { await link(temp, paths.config); }
    catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause; }
    return ok(undefined);
  } catch (cause) {
    return err({ _tag: "JsonFileUnwritable", message: `Could not seed ${paths.config}`, path: paths.config, cause });
  } finally { await rm(temp, { force: true }).catch(() => undefined); }
}

/** Parse settings, distinguishing absence from corruption. */
export async function loadConfig(paths: PluginPaths): Promise<Result<PluginConfig, InvalidConfig | JsonFileUnreadable>> {
  const raw = await readJsonFile(paths.config);
  return raw._tag === "err" ? raw : parseConfig(raw.value);
}

/** Read this session's pause/mute state. */
export async function loadControl(paths: PluginPaths): Promise<Result<Control, InvalidStateFile | JsonFileUnreadable>> {
  const raw = await readJsonFile(paths.control);
  return raw._tag === "err" ? raw : parseControl(raw.value);
}

/** Read this session's current-format counters; malformed snapshots remain untouched. */
export async function loadStats(paths: PluginPaths, now: number): Promise<Result<Stats, InvalidStateFile | JsonFileUnreadable>> {
  const raw = await readJsonFile(paths.stats);
  return raw._tag === "err" ? raw : parseStats(raw.value, now);
}

/** Persist control changes only through the session's single watcher. */
export function saveControl(paths: PluginPaths, control: Control): Promise<Result<void, JsonFileUnwritable>> {
  return writeJsonFileAtomic(paths.control, controlToJson(control));
}

/** Persist a coherent stats revision owned by one watcher. */
export function saveStats(paths: PluginPaths, stats: Stats): Promise<Result<void, JsonFileUnwritable>> {
  return writeJsonFileAtomic(paths.stats, statsToJson(stats));
}
