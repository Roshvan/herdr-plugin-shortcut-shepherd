import { actionContext, finish, invokeWatcher } from "./watcher.ts";

finish(await invokeWatcher(actionContext(), "refresh-keys"));
