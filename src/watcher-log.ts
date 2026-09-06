import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";

export function createWatcherLog(path: string): (message: string) => void {
  let warned = false;
  return (message) => {
    try {
      let size = 0;
      try { size = statSync(path).size; }
      catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause; }
      if (size >= 1024 * 1024) { rmSync(`${path}.1`, { force: true }); renameSync(path, `${path}.1`); }
      appendFileSync(path, `${new Date().toISOString()} ${message.replace(/[\r\n]/gu, " ").slice(0, 2000)}\n`, { mode: 0o600 });
    } catch {
      if (!warned) process.stderr.write(`Shortcut Shepherd cannot write its log at ${path}\n`);
      warned = true;
    }
  };
}
