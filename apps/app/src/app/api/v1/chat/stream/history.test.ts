import { describe, it, expect } from "vitest";
import type { AssistantContentBlock } from "@/components/chat/stream-event-types";
import {
  summarizeCompletedActions,
  buildAssistantHistoryText,
  buildHistoryMessages,
} from "./history";

// A tool-call block + its rendered component (the produced file), as persisted.
function toolCall(
  toolCallId: string,
  capability: string,
  status: "completed" | "failed" = "completed",
): AssistantContentBlock {
  return {
    type: "tool-call",
    toolCallId,
    capability,
    inputPreview: {},
    riskLevel: "low",
    status,
  } as AssistantContentBlock;
}

function fileComponent(toolCallId: string, name: string): AssistantContentBlock {
  return {
    type: "component",
    toolCallId,
    componentId: "file-attachment",
    props: { name },
  } as AssistantContentBlock;
}

describe("summarizeCompletedActions", () => {
  it("lists completed tool calls and marks them DONE", () => {
    const blocks: AssistantContentBlock[] = [
      toolCall("tc1", "markdown.generate"),
      fileComponent("tc1", "uss-nautilus-the-first-nuclear-submarine.md"),
      toolCall("tc2", "mermaid.generate"),
      toolCall("tc3", "svg.generate"),
    ];
    const summary = summarizeCompletedActions(blocks);
    expect(summary).toContain("DONE, do not repeat");
    expect(summary).toContain("markdown.generate → uss-nautilus-the-first-nuclear-submarine.md");
    expect(summary).toContain("mermaid.generate");
    expect(summary).toContain("svg.generate");
  });

  it("includes code executions and plans", () => {
    const blocks: AssistantContentBlock[] = [
      {
        type: "code-execute",
        toolCallId: "c1",
        language: "python",
        code: "print(1)",
        status: "completed",
      } as AssistantContentBlock,
      {
        type: "plan",
        planId: "p1",
        title: "Expand the ontology",
        steps: [],
        status: "pending",
      } as AssistantContentBlock,
    ];
    const summary = summarizeCompletedActions(blocks);
    expect(summary).toContain("code execution (python)");
    expect(summary).toContain('created the plan "Expand the ontology"');
  });

  it("omits errored tool calls (they may be retried)", () => {
    const blocks: AssistantContentBlock[] = [
      toolCall("tc1", "image.generate", "failed"),
      toolCall("tc2", "markdown.generate"),
    ];
    const summary = summarizeCompletedActions(blocks);
    expect(summary).not.toContain("image.generate");
    expect(summary).toContain("markdown.generate");
  });

  it("returns empty string when there are no re-runnable actions", () => {
    const blocks: AssistantContentBlock[] = [
      { type: "text", text: "hello" } as AssistantContentBlock,
      { type: "reasoning", reasoningId: "r1", text: "thinking" } as AssistantContentBlock,
    ];
    expect(summarizeCompletedActions(blocks)).toBe("");
  });
});

describe("buildAssistantHistoryText", () => {
  it("appends the completion summary to assistant text", () => {
    const out = buildAssistantHistoryText("I'll generate all three artifacts now.", [
      toolCall("tc1", "markdown.generate"),
    ]);
    expect(out.startsWith("I'll generate all three artifacts now.")).toBe(true);
    expect(out).toContain("markdown.generate");
    expect(out).toContain("DONE");
  });

  it("synthesizes a summary when the assistant text is empty (tool-only turn)", () => {
    const out = buildAssistantHistoryText("", [
      toolCall("tc1", "markdown.generate"),
      fileComponent("tc1", "report.md"),
    ]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("markdown.generate → report.md");
  });

  it("returns the text alone when there are no blocks", () => {
    expect(buildAssistantHistoryText("just text", [])).toBe("just text");
    expect(buildAssistantHistoryText("just text", null)).toBe("just text");
  });

  it("returns empty for a genuinely empty turn", () => {
    expect(buildAssistantHistoryText("", [])).toBe("");
  });
});

describe("buildHistoryMessages (regression for the re-execution bug)", () => {
  it("PRESERVES a tool-only assistant turn that has empty text", () => {
    // Rows are newest-first (DESC), as fetched from the DB.
    const rows = [
      { role: "user", content: "make an image", contentBlocks: [] },
      {
        // Assistant turn that produced a markdown file but NO text — previously
        // dropped entirely, which made the model re-run markdown.generate.
        role: "assistant",
        content: "",
        contentBlocks: [
          toolCall("tc1", "markdown.generate"),
          fileComponent("tc1", "nautilus.md"),
        ],
      },
      { role: "user", content: "make a markdown doc about nautilus", contentBlocks: [] },
    ];

    const messages = buildHistoryMessages(rows);

    // Chronological order, nothing dropped: user, assistant(summary), user.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!.content).toBe("make a markdown doc about nautilus");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toContain("markdown.generate → nautilus.md");
    expect(messages[1]!.content).toContain("DONE, do not repeat");
    expect(messages[2]!.content).toBe("make an image");
  });

  it("drops invalid roles and genuinely empty rows", () => {
    const rows = [
      { role: "tool", content: "ignored role", contentBlocks: [] },
      { role: "assistant", content: "   ", contentBlocks: [] }, // empty text, no actions
      { role: "user", content: "hi", contentBlocks: [] },
    ];
    const messages = buildHistoryMessages(rows);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps plain user/assistant text turns intact and chronological", () => {
    const rows = [
      { role: "assistant", content: "Second answer", contentBlocks: [] },
      { role: "user", content: "Second question", contentBlocks: [] },
      { role: "assistant", content: "First answer", contentBlocks: [] },
      { role: "user", content: "First question", contentBlocks: [] },
    ];
    const messages = buildHistoryMessages(rows);
    expect(messages.map((m) => m.content)).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
    ]);
  });
});
