export interface GitEvent {
  event: string;
  at: number;
  pid?: number;
  command?: string;
}
export function diagnosticEvents(value: unknown): GitEvent[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = Array.isArray(record.events)
    ? record.events.filter(
        (event): event is GitEvent =>
          !!event && typeof event.event === 'string' && Number.isFinite(event.at),
      )
    : [];
  return [
    ...own,
    ...Object.entries(record)
      .filter(([key]) => key !== 'events')
      .flatMap(([, child]) => diagnosticEvents(child)),
  ];
}
export function completedAutofetch(
  events: GitEvent[],
  before: GitEvent[],
  enabledAt: number,
  releasedAt: number,
): { start: GitEvent; close: GitEvent } | undefined {
  const key = (event: GitEvent) => `${event.event}:${event.at}:${event.pid}:${event.command}`;
  const old = new Set(before.map(key));
  for (const start of events) {
    if (
      start.event !== 'child-start' ||
      start.command !== 'fetch' ||
      !start.pid ||
      start.at < enabledAt ||
      old.has(key(start))
    )
      continue;
    const close = events.find(
      (event) =>
        event.event === 'child-close' &&
        event.command === 'fetch' &&
        event.pid === start.pid &&
        event.at >= start.at &&
        event.at >= releasedAt &&
        !old.has(key(event)),
    );
    if (close) return { start, close };
  }
}
export async function awaitAutofetch(options: {
  before: GitEvent[];
  enabledAt: number;
  releasedAt: number;
  focused: () => boolean;
  inspect: () => PromiseLike<unknown>;
  timeoutMs?: number;
  interrupted?: () => boolean;
}) {
  let lastDiagnostic: unknown;
  const started = Date.now(),
    samples: { at: number; focused: boolean; events: GitEvent[] }[] = [];
  while (Date.now() - started < (options.timeoutMs ?? 30000)) {
    if (options.interrupted?.()) throw new Error('AUTOFETCH_INTERRUPTED');
    const diagnostic = await options.inspect();
    lastDiagnostic = diagnostic;
    const events = diagnosticEvents(diagnostic);
    const focused = options.focused();
    samples.push({ at: Date.now(), focused, events });
    const completed = completedAutofetch(
      events,
      options.before,
      options.enabledAt,
      options.releasedAt,
    );
    const settled =
      !!diagnostic &&
      typeof diagnostic === 'object' &&
      (diagnostic as { coordinator?: { coordinator?: { state?: string } } }).coordinator
        ?.coordinator?.state === 'ready';
    if (
      focused &&
      completed &&
      settled &&
      events.some((event) => event.event === 'released' && event.at >= completed.close.at)
    )
      return { ...completed, diagnostic, samples, elapsed: Date.now() - started };
    await new Promise((done) => setTimeout(done, 50));
  }
  throw Object.assign(new Error('AUTOFETCH_COMPLETION_TIMEOUT'), {
    diagnostics: { samples, lastDiagnostic, elapsed: Date.now() - started },
  });
}
