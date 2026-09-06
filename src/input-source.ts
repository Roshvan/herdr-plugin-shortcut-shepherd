/** Input activity estimated on the same host, not verified shortcut invocations. */
export type InputKind = "key" | "mouse";

/** Unknown includes unsupported platforms, disabled monitoring, and remote clients. */
export type InputSource = InputKind | "unknown";

/** A timing sample; no key codes or text are collected. */
export type InputEvent = { readonly kind: InputKind; readonly at: number };

/** Short-lived timing history owned by one watcher. */
export type InputHistory = { events: InputEvent[] };

/** Conservative attribution limits in milliseconds. */
export const INPUT_SOURCE = { windowMs: 2500, keepMs: 15_000, dedupeMs: 20 } as const;

/** Create an empty, unavailable-by-default input history. */
export function createInputHistory(): InputHistory {
  return { events: [] };
}

/** Forget old samples even when the user stops providing input. */
export function pruneInput(history: InputHistory, now: number): void {
  history.events = history.events.filter((event) => now - event.at < INPUT_SOURCE.keepMs);
}

/** Record a finite, non-future OS sample without retaining duplicate polls. */
export function recordInput(history: InputHistory, event: InputEvent, now: number): void {
  pruneInput(history, now);
  if (!Number.isFinite(event.at) || event.at > now || now - event.at >= INPUT_SOURCE.keepMs) return;
  const duplicate = history.events.some((known) => known.kind === event.kind && Math.abs(known.at - event.at) <= INPUT_SOURCE.dedupeMs);
  if (!duplicate) history.events.push(event);
}

/** Estimate preceding activity only; later typing cannot turn a click into a key hit. */
export function classifyInput(history: InputHistory, actionAt: number): InputSource {
  const candidates = history.events
    .filter((event) => event.at >= actionAt - INPUT_SOURCE.windowMs && event.at <= actionAt)
    .toSorted((a, b) => b.at - a.at);
  const latest = candidates[0];
  if (latest === undefined) return "unknown";
  const ambiguous = candidates.some((event) => event.kind !== latest.kind && latest.at - event.at <= INPUT_SOURCE.dedupeMs);
  return ambiguous ? "unknown" : latest.kind;
}
