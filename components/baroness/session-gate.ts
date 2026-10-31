/**
 * Pure (React-free) session bookkeeping for `useBaroness`.
 *
 * Problem it solves: a late `run({ capture: A })` (e.g. a rating that resolved
 * after the visitor left) must not resurrect session A: it would abort the next
 * visitor's run, steal the voice, and roast the wrong person / an empty room.
 *
 * Rules (see `decideRun`):
 *  - A session that was cancelled or superseded is *retired*; a run for it is refused.
 *  - If a session was explicitly started (`startSession`), a run for any other id is refused.
 *  - A repeated run for the in-flight session joins the existing run.
 *  - Otherwise the run starts (this keeps `run()` without `startSession()` working).
 */

export const RETIRED_SESSION_LIMIT = 64;

/** Bounded FIFO set of session ids that must never become active again. */
export class RetiredSessions {
  private readonly ids = new Set<string>();
  constructor(private readonly limit = RETIRED_SESSION_LIMIT) {}

  add(id: string | null | undefined): void {
    if (!id) return;
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next();
      if (oldest.done) break;
      this.ids.delete(oldest.value);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }
}

export type RunDecision =
  | { action: "start" }
  | { action: "join" }
  | { action: "refuse"; reason: "retired" | "other-session-started" };

export type RunDecisionInput = {
  /** The run's session id (`capture.sessionId`). */
  sessionId: string;
  /** Session of the in-flight (or completed, not yet cancelled) run, if any. */
  inflightSessionId: string | null;
  /** Session explicitly started via `startSession`, if any (cleared by cancel). */
  startedSessionId: string | null;
  /** Whether `sessionId` has been retired. */
  retired: boolean;
};

/** Pure decision for `useBaroness().run()`. */
export function decideRun(i: RunDecisionInput): RunDecision {
  if (i.retired) return { action: "refuse", reason: "retired" };
  if (i.startedSessionId !== null && i.startedSessionId !== i.sessionId) {
    return { action: "refuse", reason: "other-session-started" };
  }
  if (i.inflightSessionId === i.sessionId) return { action: "join" };
  return { action: "start" };
}

/**
 * Session bookkeeping used by the hook (also directly testable).
 *  - `current`: the session the hook is serving (set by startSession or a started run).
 *  - `started`: the session R1 explicitly started (null if R1 only calls run()).
 */
export class SessionGate {
  readonly retired: RetiredSessions;
  current: string | null = null;
  started: string | null = null;

  constructor(limit = RETIRED_SESSION_LIMIT) {
    this.retired = new RetiredSessions(limit);
  }

  /**
   * startSession(id). Returns "ignored" for a retired id, "same" if `id` is
   * already current (no reset needed), "switched" when the previous session (if
   * any) was retired and the caller must reset its run/audio state.
   */
  start(id: string): "ignored" | "same" | "switched" {
    if (this.retired.has(id)) return "ignored";
    this.started = id;
    if (this.current === id) return "same";
    this.retired.add(this.current);
    this.current = id;
    return "switched";
  }

  /** Decide a run for `id` given the in-flight run's session. */
  decide(id: string, inflightSessionId: string | null): RunDecision {
    return decideRun({
      sessionId: id,
      inflightSessionId,
      startedSessionId: this.started,
      retired: this.retired.has(id),
    });
  }

  /** A run for `id` is starting: retire whatever session it supersedes. */
  runStarted(id: string): void {
    if (this.current !== id) this.retired.add(this.current);
    this.current = id;
  }

  /** cancel() / unmount: retire the current and started sessions and forget them. */
  cancel(): void {
    this.retired.add(this.current);
    this.retired.add(this.started);
    this.current = null;
    this.started = null;
  }
}
