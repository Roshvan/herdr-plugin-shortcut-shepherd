import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { InputEvent, InputKind } from "./input-source.ts";

/** Owned input helper; stopping waits for the actual child to exit. */
export type InputMonitor = { readonly stop: () => Promise<void> };

type MonitorPorts = {
  readonly onEvent: (event: InputEvent) => void;
  readonly onExit: (detail: string) => void;
};

const MACOS_MONITOR = fileURLToPath(new URL("./input-monitor.macos.js", import.meta.url));

const KINDS: ReadonlyMap<string, InputKind> = new Map([
  ["k", "key"],
  ["m", "mouse"],
]);

function parseMonitorLine(line: string): InputEvent | undefined {
  const [tag, stamp] = line.trim().split(" ");
  const kind = tag === undefined ? undefined : KINDS.get(tag);
  const at = Number(stamp);
  if (kind === undefined || !Number.isFinite(at)) return undefined;
  return { kind, at };
}

function attach(child: ChildProcess, ports: MonitorPorts): InputMonitor {
  if (child.stdout !== null) {
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const event = parseMonitorLine(line);
      if (event !== undefined) ports.onEvent(event);
    });
  }
  child.once("error", (cause) => ports.onExit(cause.message));
  child.once("exit", (code, signal) => ports.onExit(signal ?? `exit code ${code}`));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return {
    stop: async () => {
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}

/** Start only an explicitly requested macOS helper; unsupported platforms stay unknown. */
export function startInputMonitor(platform: NodeJS.Platform, ports: MonitorPorts): InputMonitor | undefined {
  if (platform !== "darwin") return undefined;
  const child = spawn("osascript", ["-l", "JavaScript", MACOS_MONITOR], { stdio: ["ignore", "pipe", "ignore"] });
  return attach(child, ports);
}
