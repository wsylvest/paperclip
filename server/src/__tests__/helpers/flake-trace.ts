/**
 * Env-gated flake tracing harness.
 *
 * Captures a causal timeline of a flaky test run so the residual
 * heartbeat-comment-wake flake can be diagnosed from a real failure
 * instead of static inference. See
 * doc/plans/2026-05-31-heartbeat-comment-wake-flake.md.
 *
 * THREE LAYERS, all OFF unless PAPERCLIP_FLAKE_TRACE is set:
 *
 *   1. async_hooks causal tracing — tag every async resource with the
 *      currently-active "span" (the run / test marker on the call stack)
 *      and record init/before/after/destroy. Answers: "is the promoted
 *      run's continuation even being scheduled, or is its promise stuck?"
 *
 *   2. perf_hooks event-loop delay histogram — sampled per test. Answers
 *      the single most important fork in the road: a FAILURE with high
 *      loop lag means something is hogging the loop (CPU/loop-bound
 *      blocking); a FAILURE with flat loop lag means the awaited message
 *      genuinely never arrived (delivery/logic problem). These need
 *      OPPOSITE fixes, so distinguishing them is the whole point.
 *
 *   3. wrapped query timing — every DB query's enqueue -> resolve latency
 *      and concurrent-in-flight count, so connection-pool starvation can
 *      be confirmed or ruled out with data.
 *
 * Zero overhead when disabled: enable() is a no-op, the wrap helpers
 * return their input unchanged, and async_hooks is never created.
 *
 * Activation:
 *   PAPERCLIP_FLAKE_TRACE=1                 -> trace to stderr on failure
 *   PAPERCLIP_FLAKE_TRACE=/path/to/out.jsonl -> also append events as JSONL
 */

import { createHook, type AsyncHook, executionAsyncId } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

type TraceEvent = {
  // monotonic-ish ordering counter; we cannot use Date.now() reliability
  // for sub-ms ordering, so seq is the primary sort key and tMono is a
  // best-effort high-res relative timestamp.
  seq: number;
  tMono: number;
  kind: string;
  span: string | null;
  detail?: Record<string, unknown>;
};

const ENABLED_RAW = process.env.PAPERCLIP_FLAKE_TRACE ?? "";
const ENABLED = ENABLED_RAW.length > 0;
const SINK_PATH = ENABLED && ENABLED_RAW !== "1" ? ENABLED_RAW : null;

// async_hooks is ALWAYS used for span propagation when tracing is enabled
// (that is what causally tags each DB query to the phase that issued it).
// But RECORDING every PROMISE/Timeout init produces ~150k events/run and
// evicts the actual failure window from the ring buffer. So raw async-init
// recording is opt-in behind a second flag; by default the timeline holds
// only high-signal markers (gateway phases, query timing, loop delay).
const RECORD_ASYNC = process.env.PAPERCLIP_FLAKE_TRACE_ASYNC === "1";

// Ring buffer so a long loop-until-failure run does not exhaust memory.
const MAX_EVENTS = 50_000;
const events: TraceEvent[] = [];
let seq = 0;

// hrtime base captured at module load (allowed: process.hrtime is not the
// banned Date.now/Math.random/new Date()).
const HR_BASE = process.hrtime.bigint();
function nowMs(): number {
  return Number(process.hrtime.bigint() - HR_BASE) / 1e6;
}

// ---- span stack (logical, not async) -------------------------------------
// The "current span" is whatever logical phase the synchronous call stack is
// in (a test name, "promotion", "dispatch"). async_hooks then propagates it
// to descendant async resources via the asyncId->span map.
const spanByAsyncId = new Map<number, string>();
let currentSpanFallback: string | null = null;

let hook: AsyncHook | null = null;
let elMonitor: IntervalHistogram | null = null;

function record(kind: string, span: string | null, detail?: Record<string, unknown>) {
  if (!ENABLED) return;
  const ev: TraceEvent = { seq: seq++, tMono: nowMs(), kind, span, detail };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  if (SINK_PATH) {
    try {
      appendFileSync(SINK_PATH, `${JSON.stringify(ev)}\n`);
    } catch {
      // never let tracing break the run
    }
  }
}

/** Resolve the span for the currently-executing async context. */
function activeSpan(): string | null {
  const id = executionAsyncId();
  return spanByAsyncId.get(id) ?? currentSpanFallback;
}

/**
 * Install async_hooks + the event-loop delay monitor. Idempotent.
 * No-op unless PAPERCLIP_FLAKE_TRACE is set.
 */
export function enableFlakeTrace(): void {
  if (!ENABLED || hook) return;

  hook = createHook({
    init(asyncId, type, triggerAsyncId) {
      // Inherit the span from the resource that triggered this one. This is
      // what makes the trace *causal*: a setTimeout/promise created inside
      // the promotion path stays tagged "promotion" no matter how deep.
      const inherited =
        spanByAsyncId.get(triggerAsyncId) ??
        spanByAsyncId.get(executionAsyncId()) ??
        currentSpanFallback;
      if (inherited) spanByAsyncId.set(asyncId, inherited);
      // Raw init recording is opt-in (PAPERCLIP_FLAKE_TRACE_ASYNC=1) because
      // it is extremely high-volume. Span propagation above always runs.
      if (RECORD_ASYNC && (type === "PROMISE" || type === "Timeout" || type === "Immediate")) {
        record("async.init", inherited ?? null, { asyncId, type, triggerAsyncId });
      }
    },
    before(asyncId) {
      if (!RECORD_ASYNC) return;
      const span = spanByAsyncId.get(asyncId);
      if (span) record("async.before", span, { asyncId });
    },
    after(asyncId) {
      if (!RECORD_ASYNC) return;
      const span = spanByAsyncId.get(asyncId);
      if (span) record("async.after", span, { asyncId });
    },
    destroy(asyncId) {
      spanByAsyncId.delete(asyncId);
    },
  });
  hook.enable();

  elMonitor = monitorEventLoopDelay({ resolution: 10 });
  elMonitor.enable();
}

/** Tear down hooks. Idempotent. */
export function disableFlakeTrace(): void {
  if (hook) {
    hook.disable();
    hook = null;
  }
  if (elMonitor) {
    elMonitor.disable();
    elMonitor = null;
  }
  spanByAsyncId.clear();
}

/**
 * Run `fn` with `span` as the active logical phase. The span is bound to
 * the current async id so async_hooks propagates it to descendants. Works
 * for both sync and async fn. When disabled, just calls fn().
 */
export async function withSpan<T>(span: string, fn: () => T | Promise<T>): Promise<T> {
  if (!ENABLED) return await fn();
  const id = executionAsyncId();
  const prevForId = spanByAsyncId.get(id);
  const prevFallback = currentSpanFallback;
  spanByAsyncId.set(id, span);
  currentSpanFallback = span;
  record("span.enter", span);
  try {
    return await fn();
  } finally {
    record("span.exit", span);
    currentSpanFallback = prevFallback;
    if (prevForId === undefined) spanByAsyncId.delete(id);
    else spanByAsyncId.set(id, prevForId);
  }
}

/** Emit a single labelled marker into the timeline. */
export function mark(kind: string, detail?: Record<string, unknown>): void {
  if (!ENABLED) return;
  record(kind, activeSpan(), detail);
}

// ---- query instrumentation -----------------------------------------------
let inFlightQueries = 0;
let querySeq = 0;

/**
 * Wrap a drizzle db so every query records enqueue -> resolve latency and
 * the concurrent-in-flight count at dispatch time. This is how we confirm
 * or rule out connection-pool starvation with data instead of inference.
 *
 * Returns the db unchanged when tracing is disabled. The wrapper is a thin
 * Proxy over `.select/.insert/.update/.delete/.execute` builder entrypoints;
 * it times the awaited promise of the builder, which is when drizzle/postgres
 * actually issue the query.
 */
export function traceDb<T extends object>(db: T): T {
  if (!ENABLED) return db;
  const methods = ["select", "insert", "update", "delete", "execute"] as const;
  return new Proxy(db, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && (methods as readonly string[]).includes(prop) && typeof orig === "function") {
        return (...args: unknown[]) => {
          const builder = (orig as (...a: unknown[]) => unknown).apply(target, args);
          return wrapBuilderThenable(builder, prop);
        };
      }
      return orig;
    },
  }) as T;
}

function wrapBuilderThenable(builder: unknown, op: string): unknown {
  // drizzle builders are thenables; intercept .then to time the actual await.
  if (builder == null || typeof (builder as { then?: unknown }).then !== "function") {
    return builder;
  }
  const b = builder as { then: (...a: unknown[]) => unknown };
  const origThen = b.then.bind(b);
  let started = false;
  (b as { then: unknown }).then = (onF?: unknown, onR?: unknown) => {
    if (!started) {
      started = true;
      const qid = querySeq++;
      const span = activeSpan();
      const inFlightAtDispatch = ++inFlightQueries;
      const t0 = nowMs();
      record("query.dispatch", span, { qid, op, inFlight: inFlightAtDispatch });
      const settle = (kind: string) => {
        inFlightQueries--;
        record(kind, span, { qid, op, latencyMs: nowMs() - t0, inFlight: inFlightQueries });
      };
      return origThen(
        (v: unknown) => {
          settle("query.resolve");
          return typeof onF === "function" ? (onF as (x: unknown) => unknown)(v) : v;
        },
        (e: unknown) => {
          settle("query.reject");
          if (typeof onR === "function") return (onR as (x: unknown) => unknown)(e);
          throw e;
        },
      );
    }
    return origThen(onF as never, onR as never);
  };
  return builder;
}

// ---- reporting ------------------------------------------------------------

/**
 * Snapshot the event-loop delay histogram (nanoseconds -> ms) since the
 * last reset. Call resetLoopDelay() at the start of a test to scope it.
 */
export function loopDelayStats(): Record<string, number> | null {
  if (!elMonitor) return null;
  const toMs = (ns: number) => Math.round((ns / 1e6) * 1000) / 1000;
  return {
    min: toMs(elMonitor.min),
    mean: toMs(elMonitor.mean),
    p50: toMs(elMonitor.percentile(50)),
    p99: toMs(elMonitor.percentile(99)),
    max: toMs(elMonitor.max),
  };
}

export function resetLoopDelay(): void {
  elMonitor?.reset();
}

export const flakeTraceEnabled = ENABLED;

/**
 * Dump the timeline. Pass a `reason` (e.g. the failing test name). Prints a
 * compact tail to stderr — the part right before a hang is what matters.
 */
export function dumpTrace(reason: string, tailLines = 200): void {
  if (!ENABLED) return;
  const loop = loopDelayStats();
  const tail = events.slice(-tailLines);
  const lines: string[] = [];
  lines.push("");
  lines.push("==================== FLAKE TRACE ====================");
  lines.push(`reason: ${reason}`);
  if (loop) {
    lines.push(
      `event-loop delay (ms): mean=${loop.mean} p50=${loop.p50} p99=${loop.p99} max=${loop.max}`,
    );
    lines.push(
      loop.p99 > 50
        ? "  -> HIGH loop lag during window: suspect CPU/loop-bound blocking (find the hog)."
        : "  -> FLAT loop lag: not loop-bound; suspect a message that never arrived (delivery/logic).",
    );
  }
  lines.push(`in-flight queries at dump: ${inFlightQueries}`);
  lines.push(`--- last ${tail.length} events (of ${seq} total) ---`);
  for (const ev of tail) {
    const d = ev.detail ? ` ${JSON.stringify(ev.detail)}` : "";
    lines.push(`${ev.tMono.toFixed(2)}ms  [${ev.span ?? "-"}]  ${ev.kind}${d}`);
  }
  lines.push("=====================================================");
  // eslint-disable-next-line no-console
  console.error(lines.join("\n"));
}

/** Clear the buffer between tests so each failure dump is scoped. */
export function clearTrace(): void {
  events.length = 0;
  seq = 0;
}
