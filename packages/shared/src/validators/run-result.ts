/**
 * Zod schema for the `heartbeat_runs.result_json` jsonb column.
 *
 * Validates the shape of a run's termination payload before the heartbeat
 * runtime transitions a run to `succeeded`. Validation failures cause the
 * run to be marked `failed` with `error_code='malformed_result'` so a
 * misbehaving adapter cannot silently write garbage into the durable
 * run state.
 *
 * Single shape (not a discriminated union) — `heartbeat_runs` has no
 * `kind` column today and every adapter writes the same set of optional
 * fields. If a future Tier 1 #2 workflow-stages change adds per-stage
 * result typing, that lives in a separate schema keyed by stage name.
 *
 * Feature-flagged at the call site via `PAPERCLIP_RESULT_VALIDATION_ENABLED`
 * (default false) for a soft rollout — the schema can be tightened over
 * several PRs before the flag flips on.
 */
import { z } from "zod";

/**
 * The fields the heartbeat runtime itself writes to resultJson across
 * the existing call sites. All optional — runs may finalize with an
 * empty object.
 *
 * Sourced from the existing literal sites in
 * `server/src/services/heartbeat.ts`:
 *   - stopReason: machine-readable termination reason ('issue_dependencies_blocked',
 *     'stale_queued_run_gate', adapter-emitted strings, etc.)
 *   - effectiveTimeoutSec / timeoutConfigured / timeoutSource / timeoutFired:
 *     surfaced in dependency-blocked + stale-queued cancellations.
 *   - errorFamily / retryNotBefore: written by mergeAdapterRecoveryMetadata
 *     for retry scheduling.
 *   - modelProfile metadata: written by mergeModelProfileRunMetadata.
 *
 * Adapter-specific fields (anything else) are permitted via the
 * passthrough `.catchall(z.unknown())` so adapters that write extra
 * keys do not fail validation. The schema's job is to catch obviously
 * malformed shapes (wrong type on a known key), not to police adapter
 * extensions.
 */
export const runResultJsonSchema = z
  .object({
    stopReason: z.string().optional(),
    effectiveTimeoutSec: z.number().optional(),
    timeoutConfigured: z.boolean().optional(),
    timeoutSource: z.string().optional(),
    timeoutFired: z.boolean().optional(),
    errorFamily: z.string().nullable().optional(),
    retryNotBefore: z.string().nullable().optional(),
    modelProfile: z.record(z.unknown()).optional(),
  })
  .catchall(z.unknown());

export type RunResultJson = z.infer<typeof runResultJsonSchema>;

/**
 * Validate a value as a run result payload. Returns the parsed value
 * on success, or a typed error describing the first failure.
 *
 * Accepts `null` and `undefined` — finalizing with no result is valid;
 * we only validate the shape when one is present.
 */
export function validateRunResultJson(
  value: unknown,
): { ok: true; value: RunResultJson | null } | { ok: false; error: string; path: string[] } {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "resultJson must be an object (got " + (Array.isArray(value) ? "array" : typeof value) + ")",
      path: [],
    };
  }
  const parsed = runResultJsonSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: issue?.message ?? "resultJson failed schema validation",
    path: issue?.path?.map(String) ?? [],
  };
}
