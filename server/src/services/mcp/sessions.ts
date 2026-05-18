/**
 * MCP gateway session registry.
 *
 * Tracks live Mcp-Session-Id tokens issued on `initialize` and the SSE streams
 * that agents open via GET /companies/:companyId/mcp/rpc.
 *
 * Sessions have a 1-hour TTL from createdAt, swept on each new initialize.
 *
 * TODO: Last-Event-ID replay / resumability is NOT implemented.
 *       To add it, store a circular event buffer per session and replay
 *       events since the Last-Event-ID value on reconnect.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  companyId: string;
  agentId: string;
  /** Null when the MCP request was not associated with a heartbeat run. */
  runId: string | null;
  createdAt: Date;
}

interface StreamHandle {
  write: (chunk: string) => boolean;
  end: () => void;
}

export interface SseEvent {
  /** SSE event field (default "message"). */
  event?: string;
  /** SSE data field — should be a JSON string. */
  data: string;
  /** Optional SSE id field. Useful for future Last-Event-ID support. */
  eventId?: string;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** sessionId → record */
const _sessions = new Map<string, SessionRecord>();

/** sessionId → active SSE write handles (multiple tabs / connections per session are valid) */
const _streams = new Map<string, Set<StreamHandle>>();

// ---------------------------------------------------------------------------
// TTL sweep: called on each new initialize so the map stays bounded.
// ---------------------------------------------------------------------------

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, record] of _sessions.entries()) {
    if (now - record.createdAt.getTime() > SESSION_TTL_MS) {
      _sessions.delete(id);
      _streams.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new session entry and return the session id.
 * Also sweeps any expired sessions to keep the map bounded.
 */
export function createSession(opts: {
  companyId: string;
  agentId: string;
  runId: string | null;
}): string {
  sweepExpired();
  const id = randomUUID();
  _sessions.set(id, {
    companyId: opts.companyId,
    agentId: opts.agentId,
    runId: opts.runId,
    createdAt: new Date(),
  });
  return id;
}

/**
 * Look up an existing, non-expired session by id.
 * Returns null if the session is unknown or has expired.
 */
export function lookupSession(id: string): SessionRecord | null {
  const record = _sessions.get(id);
  if (!record) return null;
  if (Date.now() - record.createdAt.getTime() > SESSION_TTL_MS) {
    _sessions.delete(id);
    _streams.delete(id);
    return null;
  }
  return record;
}

/**
 * Attach an SSE write handle to a session.
 *
 * Returns a detach function that must be called when the connection closes
 * to prevent writing to a dead socket.
 */
export function attachStreamToSession(
  id: string,
  write: (chunk: string) => boolean,
  end: () => void,
): () => void {
  let handles = _streams.get(id);
  if (!handles) {
    handles = new Set();
    _streams.set(id, handles);
  }
  const handle: StreamHandle = { write, end };
  handles.add(handle);

  return () => {
    const set = _streams.get(id);
    if (set) {
      set.delete(handle);
      if (set.size === 0) {
        _streams.delete(id);
      }
    }
  };
}

/**
 * Broadcast an SSE event to all active streams for a session.
 *
 * Returns true if at least one stream received the event, false otherwise
 * (session has no attached streams — that is normal and not an error).
 */
export function broadcastToSession(id: string, event: SseEvent): boolean {
  const handles = _streams.get(id);
  if (!handles || handles.size === 0) return false;

  const frame = formatSseFrame(event);
  let sent = false;
  for (const handle of handles) {
    try {
      handle.write(frame);
      sent = true;
    } catch {
      // Stale handle — remove it
      handles.delete(handle);
    }
  }
  if (handles.size === 0) {
    _streams.delete(id);
  }
  return sent;
}

// ---------------------------------------------------------------------------
// SSE frame formatting
// ---------------------------------------------------------------------------

/**
 * Serialize a single SSE event into the wire format:
 *
 *   [id: <eventId>\n]
 *   [event: <event>\n]
 *   data: <data>\n
 *   \n
 */
export function formatSseFrame(event: SseEvent): string {
  let frame = "";
  if (event.eventId !== undefined) {
    frame += `id: ${event.eventId}\n`;
  }
  if (event.event !== undefined && event.event !== "message") {
    frame += `event: ${event.event}\n`;
  }
  // data lines — split on newlines so multi-line payloads are valid SSE
  for (const line of event.data.split("\n")) {
    frame += `data: ${line}\n`;
  }
  frame += "\n";
  return frame;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all session state. For use in tests only. */
export function _resetSessionsForTesting(): void {
  _sessions.clear();
  _streams.clear();
}
