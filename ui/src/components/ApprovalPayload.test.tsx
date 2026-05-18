// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("renders mcp_tool_call payload with serverName, toolName and decoded args preview", () => {
    const root = createRoot(container);

    // Encode a small JSON args object as base64 for the preview
    const argsJson = JSON.stringify({ env: "production", region: "us-east-1" });
    const preview = btoa(argsJson);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="mcp_tool_call"
          payload={{
            serverName: "infra",
            toolName: "deploy_service",
            agentId: "00000000-0000-0000-0000-000000000001",
            requestPayloadPreview: preview,
          }}
        />,
      );
    });

    // Should show the tool path
    expect(container.textContent).toContain("infra.deploy_service");
    // Should show decoded JSON args
    expect(container.textContent).toContain("production");
    expect(container.textContent).toContain("us-east-1");

    act(() => {
      root.unmount();
    });
  });

  it("renders mcp_tool_call payload gracefully when preview is invalid base64", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="mcp_tool_call"
          payload={{
            serverName: "infra",
            toolName: "destroy_all",
            requestPayloadPreview: "!!!notvalidbase64!!!",
          }}
        />,
      );
    });

    // Tool path must render; preview failure must not crash
    expect(container.textContent).toContain("infra.destroy_all");

    act(() => {
      root.unmount();
    });
  });
});
