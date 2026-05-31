/**
 * Env-gated runtime trace sink — production-safe, zero-cost when disabled.
 *
 * This is the SHARED primitive the flake tracing harness
 * (server/src/__tests__/helpers/flake-trace.ts) and production code
 * (heartbeat.ts) both write into, so production `runtimeMark()` calls and
 * test-side gateway/query markers land in ONE ordered timeline.
 *
 * It contains NO test dependency and is safe to import from production
 * services. Everything is a no-op unless PAPERCLIP_FLAKE_TRACE is set.
 *
 * Why a separate module from flake-trace.ts: production code must not
 * import from the test tree. flake-trace.ts owns async_hooks / perf_hooks
 * / query wrapping / reporting; this module owns only the event buffer and
 * the mark() write path, which is the sole thing production needs.
 */

export type RuntimeTraceEvent = {
  seq: number;
  tMono: number;
  kind: string;
  detail?: Record<string, unknown>;
};

const ENABLED = (process.env.PAPERCLIP_FLAKE_TRACE ?? "").length > 0;

const MAX_EVENTS = 50_000;
const buffer: RuntimeTraceEvent[] = [];
let seq = 0;

// process.hrtime is permitted (Date.now/Math.random/new Date() are not).
const HR_BASE = process.hrtime.bigint();
function nowMs(): number {
  return Number(process.hrtime.bigint() - HR_BASE) / 1e6;
}

export const runtimeTraceEnabled = ENABLED;

/**
 * Record a labelled marker. No-op unless tracing is enabled. Safe to call
 * from hot paths when disabled — it returns before any allocation.
 */
export function runtimeMark(kind: string, detail?: Record<string, unknown>): void {
  if (!ENABLED) return;
  buffer.push({ seq: seq++, tMono: nowMs(), kind, detail });
  if (buffer.length > MAX_EVENTS) buffer.shift();
}

/** Read-only view of the buffer for the reporting layer. */
export function runtimeTraceEvents(): readonly RuntimeTraceEvent[] {
  return buffer;
}

/** Clear the buffer (called between tests by the harness). */
export function clearRuntimeTrace(): void {
  buffer.length = 0;
  seq = 0;
}

/** Current event count, for reporting headers. */
export function runtimeTraceSeq(): number {
  return seq;
}
