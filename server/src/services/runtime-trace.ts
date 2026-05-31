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

import { appendFileSync } from "node:fs";

export type RuntimeTraceEvent = {
  seq: number;
  tMono: number;
  kind: string;
  detail?: Record<string, unknown>;
};

const ENABLED_RAW = process.env.PAPERCLIP_FLAKE_TRACE ?? "";
const ENABLED = ENABLED_RAW.length > 0;
// When PAPERCLIP_FLAKE_TRACE is a path (not "1"), every mark — production
// AND test — is appended as JSONL there, so the on-disk timeline is the
// same single source of truth as the in-memory failure dump.
const SINK_PATH = ENABLED && ENABLED_RAW !== "1" ? ENABLED_RAW : null;

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
 * Record a labelled marker. No-op unless tracing is enabled.
 *
 * `detail` may be a plain object or a thunk. Prefer the thunk form on hot
 * paths: when tracing is disabled the function returns before the thunk
 * runs, so no detail object is allocated. (With a plain object the caller
 * still allocates it at the call site regardless of ENABLED, which is why
 * hot-path callers should pass `() => ({...})`.)
 */
export function runtimeMark(
  kind: string,
  detail?: Record<string, unknown> | (() => Record<string, unknown>),
): void {
  if (!ENABLED) return;
  const resolved = typeof detail === "function" ? detail() : detail;
  const ev: RuntimeTraceEvent = { seq: seq++, tMono: nowMs(), kind, detail: resolved };
  buffer.push(ev);
  if (buffer.length > MAX_EVENTS) buffer.shift();
  if (SINK_PATH) {
    try {
      appendFileSync(SINK_PATH, `${JSON.stringify({ kind, ...(resolved ?? {}) })}\n`);
    } catch {
      // never let tracing break the run
    }
  }
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
