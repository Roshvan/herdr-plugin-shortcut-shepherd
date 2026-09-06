import { spawn } from "node:child_process";
import { ok, err, type Result } from "./result.ts";
import type { Nudge } from "./nudge-policy.ts";
import type { PluginConfig } from "./config.ts";

export type HerdrCliFailed = { readonly _tag: "HerdrCliFailed"; readonly message: string };

type CliOptions = { readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly signal?: AbortSignal };

function failed(detail: string): HerdrCliFailed {
  return { _tag: "HerdrCliFailed", message: `Herdr CLI: ${detail}` };
}

function runHerdr(bin: string, args: ReadonlyArray<string>, options: CliOptions = {}): Promise<Result<string, HerdrCliFailed>> {
  if (options.signal?.aborted) return Promise.resolve(err(failed("cancelled")));
  return new Promise((resolve) => {
    let stdout = "";
    let bytes = 0;
    let failure: HerdrCliFailed | undefined;
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const cancel = (detail: string) => { failure ??= failed(detail); child.kill("SIGKILL"); };
    const abort = () => cancel("cancelled");
    const timer = setTimeout(() => cancel("deadline exceeded"), options.timeoutMs ?? 5000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 256 * 1024)) cancel("output limit exceeded");
    };
    child.stdout.on("data", (chunk: Buffer) => { count(chunk); if (failure === undefined) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", count);
    child.once("error", () => { failure ??= failed(`could not launch ${bin}`); });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure !== undefined) resolve(err(failure));
      else resolve(code === 0 ? ok(stdout) : err(failed(`exit code ${code}; inspect Herdr logs`)));
    });
  });
}

export async function showToast(bin: string, nudge: Nudge, config: PluginConfig, signal?: AbortSignal): Promise<Result<void, HerdrCliFailed>> {
  const options = signal === undefined ? {} : { signal };
  const result = await runHerdr(bin, ["notification", "show", nudge.title, "--body", nudge.body, "--position", config.position], options);
  return result._tag === "ok" ? ok(undefined) : result;
}

export async function openPane(bin: string, pluginId: string, entrypoint: string): Promise<Result<void, HerdrCliFailed>> {
  const result = await runHerdr(bin, ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", entrypoint]);
  return result._tag === "ok" ? ok(undefined) : result;
}
