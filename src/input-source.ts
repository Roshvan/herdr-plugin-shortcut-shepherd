export type InputKind = "key" | "mouse";

export type InputSource = InputKind | "unknown";

export type InputEvent = { readonly kind: InputKind; readonly at: number };

export type InputHistory = { events: InputEvent[] };

const INPUT_SOURCE = { windowMs: 2500, keepMs: 15_000, dedupeMs: 20 } as const;

export function createInputHistory(): InputHistory {
  return { events: [] };
}

export function pruneInput(history: InputHistory, now: number): void {
  history.events = history.events.filter((event) => now - event.at < INPUT_SOURCE.keepMs);
}

export function recordInput(history: InputHistory, event: InputEvent, now: number): void {
  pruneInput(history, now);
  if (!Number.isFinite(event.at) || event.at > now || now - event.at >= INPUT_SOURCE.keepMs) return;
  const duplicate = history.events.some((known) => known.kind === event.kind && Math.abs(known.at - event.at) <= INPUT_SOURCE.dedupeMs);
  if (!duplicate) history.events.push(event);
}

export function classifyInput(history: InputHistory, actionAt: number): InputSource {
  const candidates = history.events
    .filter((event) => event.at >= actionAt - INPUT_SOURCE.windowMs && event.at <= actionAt)
    .toSorted((a, b) => b.at - a.at);
  const latest = candidates[0];
  if (latest === undefined) return "unknown";
  const ambiguous = candidates.some((event) => event.kind !== latest.kind && latest.at - event.at <= INPUT_SOURCE.dedupeMs);
  return ambiguous ? "unknown" : latest.kind;
}
