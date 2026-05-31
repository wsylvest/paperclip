import { describe, expect, it } from "vitest";
import {
  parseKimiStreamJson,
  isKimiTransientUpstreamError,
  isKimiMaxTurnsResult,
  isKimiUnknownSessionError,
  detectKimiLoginRequired,
  describeKimiFailure,
} from "./parse.js";

// ---------------------------------------------------------------------------
// parseKimiStreamJson
// ---------------------------------------------------------------------------

describe("parseKimiStreamJson", () => {
  it("returns null resultJson and empty usage on empty stdout", () => {
    const result = parseKimiStreamJson("");
    expect(result.resultJson).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe("");
  });

  it("parses a complete stream: init + assistant + result", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc", model: "kimi-k2" }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess-abc",
        message: { content: [{ type: "text", text: "Hello from Kimi!" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "sess-abc",
        result: "Done.",
        is_error: false,
        total_cost_usd: 0.001,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      }),
    ].join("\n");

    const result = parseKimiStreamJson(lines);
    expect(result.sessionId).toBe("sess-abc");
    expect(result.model).toBe("kimi-k2");
    expect(result.costUsd).toBe(0.001);
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.cachedInputTokens).toBe(10);
    expect(result.summary).toBe("Done.");
    expect(result.resultJson).not.toBeNull();
  });

  it("accumulates assistant text blocks when result line is missing", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "kimi-k1.5" }),
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "text", text: "Part one. " }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "text", text: "Part two." }] },
      }),
    ].join("\n");

    const result = parseKimiStreamJson(lines);
    expect(result.resultJson).toBeNull();
    expect(result.summary).toContain("Part one.");
    expect(result.summary).toContain("Part two.");
    expect(result.sessionId).toBe("s1");
  });

  it("skips non-JSON lines gracefully", () => {
    const lines = [
      "not json",
      JSON.stringify({ type: "result", session_id: "s2", result: "ok", is_error: false }),
      "also not json",
    ].join("\n");

    const result = parseKimiStreamJson(lines);
    expect(result.resultJson).not.toBeNull();
    expect(result.sessionId).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// isKimiTransientUpstreamError
// ---------------------------------------------------------------------------

describe("isKimiTransientUpstreamError", () => {
  it("classifies rate limit errors as transient", () => {
    expect(isKimiTransientUpstreamError({ stderr: "HTTP 429: Too Many Requests" })).toBe(true);
    expect(isKimiTransientUpstreamError({ errorMessage: "rate_limit_error: slow down" })).toBe(true);
    expect(isKimiTransientUpstreamError({ errorMessage: "Service temporarily unavailable" })).toBe(true);
    expect(isKimiTransientUpstreamError({ errorMessage: "quota exceeded" })).toBe(true);
  });

  it("classifies overloaded errors as transient", () => {
    expect(isKimiTransientUpstreamError({ stderr: "Server overloaded. Try again later." })).toBe(true);
  });

  it("does not classify auth failures as transient", () => {
    expect(isKimiTransientUpstreamError({ stderr: "Please log in. Run `kimi login` first." })).toBe(false);
  });

  it("does not classify max-turns as transient", () => {
    expect(
      isKimiTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
  });

  it("does not classify unknown session as transient", () => {
    expect(
      isKimiTransientUpstreamError({
        parsed: { result: "No conversation found with session id abc-123" },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isKimiMaxTurnsResult
// ---------------------------------------------------------------------------

describe("isKimiMaxTurnsResult", () => {
  it("detects error_max_turns subtype", () => {
    expect(isKimiMaxTurnsResult({ subtype: "error_max_turns" })).toBe(true);
  });

  it("detects max_turns stop reason", () => {
    expect(isKimiMaxTurnsResult({ stop_reason: "max_turns" })).toBe(true);
    expect(isKimiMaxTurnsResult({ stopReason: "max_turns_exhausted" })).toBe(true);
    expect(isKimiMaxTurnsResult({ error_code: "turn_limit" })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isKimiMaxTurnsResult(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isKimiUnknownSessionError
// ---------------------------------------------------------------------------

describe("isKimiUnknownSessionError", () => {
  it("detects no conversation found error", () => {
    expect(
      isKimiUnknownSessionError({ result: "No conversation found with session id abc-123" }),
    ).toBe(true);
  });

  it("detects unknown session error", () => {
    expect(isKimiUnknownSessionError({ result: "Unknown session abc-123" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isKimiUnknownSessionError({ result: "Some other error" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectKimiLoginRequired
// ---------------------------------------------------------------------------

describe("detectKimiLoginRequired", () => {
  it("detects login required from stderr", () => {
    const result = detectKimiLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "Please log in. Run `kimi login` first.",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects login required from result text", () => {
    const result = detectKimiLoginRequired({
      parsed: { result: "authentication required" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("returns false when no auth issue", () => {
    const result = detectKimiLoginRequired({
      parsed: { result: "Task completed." },
      stdout: "Success",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeKimiFailure
// ---------------------------------------------------------------------------

describe("describeKimiFailure", () => {
  it("includes subtype and result text", () => {
    const msg = describeKimiFailure({ subtype: "error_max_turns", result: "Max turns hit." });
    expect(msg).toContain("Kimi run failed");
    expect(msg).toContain("error_max_turns");
    expect(msg).toContain("Max turns hit.");
  });

  it("returns null when no detail is available", () => {
    expect(describeKimiFailure({})).toBeNull();
  });
});
