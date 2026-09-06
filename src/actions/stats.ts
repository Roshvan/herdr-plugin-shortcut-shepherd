import { openPane } from "../herdr-cli.ts";
import { actionContext, ensureWatcher, fail, finish } from "./watcher.ts";

const context = actionContext();
await ensureWatcher(context);
const opened = await openPane(context.env.herdrBin, context.env.pluginId, "stats");
if (opened._tag === "err") fail(opened.error.message);
finish("Opened Shortcut Shepherd stats.");
