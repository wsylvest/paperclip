/**
 * permissions.test.ts
 *
 * Unit tests for buildClaudeExecutionPermissionArgs.
 *
 * Tests:
 *  1. No selectedMcpToolNames: non-sandbox returns --dangerously-skip-permissions.
 *  2. No selectedMcpToolNames: sandbox returns --allowedTools SANDBOX_ALLOWED_TOOLS.
 *  3. dangerouslySkipPermissions=false: returns [] regardless of other inputs.
 *  4. With selectedMcpToolNames in non-sandbox mode: switches to --allowedTools
 *     with EXECUTION_FALLBACK_ALLOWED_TOOLS + mcp__paperclip__* prefixed tools.
 *  5. With selectedMcpToolNames in sandbox mode: uses SANDBOX_ALLOWED_TOOLS base
 *     + mcp__paperclip__* prefixed tools.
 *  6. PAPERCLIP_CLAUDE_SKILL_SELECTION_NARROW_MCP=false: selectedMcpToolNames ignored.
 *  7. Empty selectedMcpToolNames array: treated same as no narrowing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeExecutionPermissionArgs,
  EXECUTION_FALLBACK_ALLOWED_TOOLS,
} from "./permissions.js";

const SANDBOX_TOOLS =
  "Task AskUserQuestion Bash(*) CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

describe("buildClaudeExecutionPermissionArgs", () => {
  const originalNarrowMcp = process.env.PAPERCLIP_CLAUDE_SKILL_SELECTION_NARROW_MCP;

  afterEach(() => {
    if (originalNarrowMcp === undefined) {
      delete process.env.PAPERCLIP_CLAUDE_SKILL_SELECTION_NARROW_MCP;
    } else {
      process.env.PAPERCLIP_CLAUDE_SKILL_SELECTION_NARROW_MCP = originalNarrowMcp;
    }
  });

  // -------------------------------------------------------------------------
  // 1. No MCP narrowing, non-sandbox
  // -------------------------------------------------------------------------
  it("returns --dangerously-skip-permissions when dangerouslySkipPermissions=true, non-sandbox, no selected tools", () => {
    const result = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsSandbox: false,
    });
    expect(result).toEqual(["--dangerously-skip-permissions"]);
  });

  // -------------------------------------------------------------------------
  // 2. No MCP narrowing, sandbox
  // -------------------------------------------------------------------------
  it("returns --allowedTools with sandbox list when dangerouslySkipPermissions=true, sandbox, no selected tools", () => {
    const result = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsSandbox: true,
    });
    expect(result).toEqual(["--allowedTools", SANDBOX_TOOLS]);
  });

  // -------------------------------------------------------------------------
  // 3. dangerouslySkipPermissions=false → always []
  // -------------------------------------------------------------------------
  it("returns [] when dangerouslySkipPermissions=false regardless of other inputs", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: false,
        targetIsSandbox: false,
        selectedMcpToolNames: ["github__create_issue"],
      }),
    ).toEqual([]);

    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: false,
        targetIsSandbox: true,
      }),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. MCP narrowing, non-sandbox
  // -------------------------------------------------------------------------
  it("switches to --allowedTools with fallback builtins + prefixed MCP tools in non-sandbox mode", () => {
    const result = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsSandbox: false,
      selectedMcpToolNames: ["github__create_issue", "github__list_issues"],
    });

    expect(result[0]).toBe("--allowedTools");
    const allowedList = result[1] ?? "";
    // Should contain all fallback tools
    expect(allowedList).toContain(EXECUTION_FALLBACK_ALLOWED_TOOLS);
    // Should contain the prefixed MCP tool names
    expect(allowedList).toContain("mcp__paperclip__github__create_issue");
    expect(allowedList).toContain("mcp__paperclip__github__list_issues");
  });

  // -------------------------------------------------------------------------
  // 5. MCP narrowing, sandbox
  // -------------------------------------------------------------------------
  it("appends prefixed MCP tools to sandbox allowlist when in sandbox mode", () => {
    const result = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsSandbox: true,
      selectedMcpToolNames: ["jira__create_ticket"],
    });

    expect(result[0]).toBe("--allowedTools");
    const allowedList = result[1] ?? "";
    expect(allowedList).toContain(SANDBOX_TOOLS);
    expect(allowedList).toContain("mcp__paperclip__jira__create_ticket");
  });

  // -------------------------------------------------------------------------
  // 6. Opt-out env flag: PAPERCLIP_CLAUDE_SKILL_SELECTION_NARROW_MCP=false
  // -------------------------------------------------------------------------
  it("ignores selectedMcpToolNames when PAPERCLIP_CLAUDE_SKILL_SELECTION_NARROW_MCP=false", () => {
    process.env.PAPERCLIP_CLAUDE_SKILL_SELECTION_NARROW_MCP = "false";

    const result = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsSandbox: false,
      selectedMcpToolNames: ["github__create_issue"],
    });

    // Should fall back to --dangerously-skip-permissions (no narrowing)
    expect(result).toEqual(["--dangerously-skip-permissions"]);
  });

  // -------------------------------------------------------------------------
  // 7. Empty selectedMcpToolNames array → treated as no narrowing
  // -------------------------------------------------------------------------
  it("treats an empty selectedMcpToolNames array the same as no narrowing", () => {
    const result = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsSandbox: false,
      selectedMcpToolNames: [],
    });
    expect(result).toEqual(["--dangerously-skip-permissions"]);
  });
});
