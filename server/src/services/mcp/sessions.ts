/**
 * MCP gateway session registry.
 *
 * Tracks live Mcp-Session-Id tokens issued on `initialize` and the SSE streams
 * that agents open via GET /companies/:companyId/mcp/rpc.
 *
 * Sessions have a 1-hour TTL from createdAt, swept on each new initialize.
 *
 * Last-Event-ID replay: each session keeps a bounded circular buffer of every
 * SSE frame broadcast through `broadcastToSession`. When an agent reconnects
 * its GET stream with a `Last-Event-ID` header, the route calls
 * `replaySinceForSession` to flush every event newer than that id before
 * resuming live fan-in. Buffer size is capped via
 * PAPERCLIP_MCP_SSE_REPLAY_BUFFER_SIZE (default 1000).
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

function readReplayBufferSize(): number {
  const raw = Number(process.env.PAPERCLIP_MCP_SSE_REPLAY_BUFFER_SIZE);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 1000;
}

/** Per-session bounded circular buffer of broadcast frames keyed by eventId. */
interface BufferedEvent {
  /** Monotonic id within the session. Same value emitted as the SSE `id:` field. */
  eventId: number;
  frame: string;
}

interface SessionBuffer {
  /** Newest eventId seen so far. Starts at 0; first event is 1. */
  nextEventId: number;
  /** FIFO ring; bounded by readReplayBufferSize(). Oldest at index 0. */
  events: BufferedEvent[];
}

/** sessionId → record */
const _sessions = new Map<string, SessionRecord>();

/** sessionId → active SSE write handles (multiple tabs / connections per session are valid) */
const _streams = new Map<string, Set<StreamHandle>>();

/** sessionId → replay buffer */
const _buffers = new Map<string, SessionBuffer>();

// ---------------------------------------------------------------------------
// TTL sweep: called on each new initialize so the map stays bounded.
// ---------------------------------------------------------------------------

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, record] of _sessions.entries()) {
    if (now - record.createdAt.getTime() > SESSION_TTL_MS) {
      _sessions.delete(id);
      _streams.delete(id);
      _buffers.delete(id);
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
    _buffers.delete(id);
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
 * Every broadcast is also recorded in the session's replay buffer (bounded
 * by PAPERCLIP_MCP_SSE_REPLAY_BUFFER_SIZE; oldest evicted first) so a
 * reconnecting agent can request the missed frames via Last-Event-ID. If
 * the caller does not supply `eventId`, a monotonic per-session id is
 * assigned automatically.
 *
 * Returns true if at least one stream received the event, false otherwise
 * (session has no attached streams — that is normal and not an error).
 */
export function broadcastToSession(id: string, event: SseEvent): boolean {
  if (!_sessions.has(id)) return false;

  let buffer = _buffers.get(id);
  if (!buffer) {
    buffer = { nextEventId: 0, events: [] };
    _buffers.set(id, buffer);
  }
  const assignedId = ++buffer.nextEventId;
  const eventWithId: SseEvent = {
    ...event,
    eventId: event.eventId ?? String(assignedId),
  };

  const frame = formatSseFrame(eventWithId);

  // Append to the buffer; evict the oldest when capacity is reached.
  const capacity = readReplayBufferSize();
  if (capacity > 0) {
    buffer.events.push({ eventId: assignedId, frame });
    while (buffer.events.length > capacity) buffer.events.shift();
  }

  const handles = _streams.get(id);
  if (!handles || handles.size === 0) return false;

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

/**
 * Replay buffered events with eventId > lastEventId for a session.
 *
 * Returns null if the session is unknown or has no buffer yet.
 *
 * Otherwise returns:
 *   - { frames }: every frame whose eventId is strictly greater than
 *     lastEventId, in order. May be empty if the client is already
 *     caught up.
 *   - { gap: true } iff lastEventId is older than the oldest event
 *     still in the buffer (eviction has occurred). The caller should
 *     emit a `:gap` comment so the agent knows it has missed events.
 */
export function replaySinceForSession(
  id: string,
  lastEventId: number,
): { frames: string[]; gap: boolean } | null {
  if (!_sessions.has(id)) return null;
  const buffer = _buffers.get(id);
  if (!buffer || buffer.events.length === 0) {
    return { frames: [], gap: false };
  }

  const oldest = buffer.events[0]!.eventId;
  const gap = lastEventId < oldest - 1;

  const frames: string[] = [];
  for (const evt of buffer.events) {
    if (evt.eventId > lastEventId) frames.push(evt.frame);
  }
  return { frames, gap };
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
  _buffers.clear();
}

/** Returns the current buffered-event count for a session. Test helper only. */
export function _getBufferedEventCountForTesting(id: string): number {
  return _buffers.get(id)?.events.length ?? 0;
}
