import { actionContext, ensureWatcher, finish } from "./watcher.ts";

finish(await ensureWatcher(actionContext()));
