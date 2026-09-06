import { stopWatcher } from "../watcher-process.ts";
import { actionContext, fail, finish } from "./watcher.ts";

const result = await stopWatcher(actionContext().paths);
if (result._tag === "err") fail(result.error.message);
finish(result.value);
