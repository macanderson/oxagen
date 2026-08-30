import { describe, it, expect } from "vitest";
import type { AssistantContentBlock } from "@/components/chat/stream-event-types";
import {
  summarizeCompletedActions,
  buildAssistantHistoryText,
  buildHistoryMessages,
  collectRecentAttachmentPublicIds,
  type ResolvedHistoryImage,
} from "./history";

function attachmentMeta(
  ...attachments: Array<{ publicId: string; kind?: string; name?: string }>
) {
  return {
    attachments: attachments.map((a) => ({
      publicId: a.publicId,
      kind: a.kind ?? "image",
      name: a.name ?? `${a.publicId}.png`,
    })),
  };
}

function resolvedImage(
  data: number[] = [1, 2, 3],
  mediaType = "image/png",
): ResolvedHistoryImage {
  return { data: Buffer.from(data), mediaType };
}

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

function fileComponent(
  toolCallId: string,
  name: string,
): AssistantContentBlock {
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
      toolCall("tc1", "generate_markdown"),
      fileComponent("tc1", "uss-nautilus-the-first-nuclear-submarine.md"),
      toolCall("tc2", "generate_mermaid"),
      toolCall("tc3", "generate_svg"),
    ];
    const summary = summarizeCompletedActions(blocks);
    expect(summary).toContain("DONE, do not repeat");
    expect(summary).toContain(
      "generate_markdown → uss-nautilus-the-first-nuclear-submarine.md",
    );
    expect(summary).toContain("generate_mermaid");
    expect(summary).toContain("generate_svg");
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
      toolCall("tc1", "generate_image", "failed"),
      toolCall("tc2", "generate_markdown"),
    ];
    const summary = summarizeCompletedActions(blocks);
    expect(summary).not.toContain("generate_image");
    expect(summary).toContain("generate_markdown");
  });

  it("returns empty string when there are no re-runnable actions", () => {
    const blocks: AssistantContentBlock[] = [
      { type: "text", text: "hello" } as AssistantContentBlock,
      {
        type: "reasoning",
        reasoningId: "r1",
        text: "thinking",
      } as AssistantContentBlock,
    ];
    expect(summarizeCompletedActions(blocks)).toBe("");
  });
});

describe("buildAssistantHistoryText", () => {
  it("appends the completion summary to assistant text", () => {
    const out = buildAssistantHistoryText(
      "I'll generate all three artifacts now.",
      [toolCall("tc1", "generate_markdown")],
    );
    expect(out.startsWith("I'll generate all three artifacts now.")).toBe(true);
    expect(out).toContain("generate_markdown");
    expect(out).toContain("DONE");
  });

  it("synthesizes a summary when the assistant text is empty (tool-only turn)", () => {
    const out = buildAssistantHistoryText("", [
      toolCall("tc1", "generate_markdown"),
      fileComponent("tc1", "report.md"),
    ]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("generate_markdown → report.md");
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
          toolCall("tc1", "generate_markdown"),
          fileComponent("tc1", "nautilus.md"),
        ],
      },
      {
        role: "user",
        content: "make a markdown doc about nautilus",
        contentBlocks: [],
      },
    ];

    const messages = buildHistoryMessages(rows);

    // Chronological order, nothing dropped: user, assistant(summary), user.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!.content).toBe("make a markdown doc about nautilus");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toContain("generate_markdown → nautilus.md");
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

describe("collectRecentAttachmentPublicIds", () => {
  it("returns [] when no rows have attachments", () => {
    const rows = [{ role: "user", content: "hi", contentBlocks: [] }];
    expect(collectRecentAttachmentPublicIds(rows)).toEqual([]);
  });

  it("collects image-kind attachment ids from the most recent 2 user turns", () => {
    // Newest-first, as fetched from the DB.
    const rows = [
      {
        role: "user",
        content: "third",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_3" }),
      },
      { role: "assistant", content: "reply", contentBlocks: [] },
      {
        role: "user",
        content: "second",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_2" }),
      },
      { role: "assistant", content: "reply", contentBlocks: [] },
      {
        role: "user",
        content: "first",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_1" }),
      },
    ];
    // Only the newest 2 user turns (gen_3, gen_2) — gen_1 is the 3rd-back turn.
    expect(collectRecentAttachmentPublicIds(rows)).toEqual(["gen_3", "gen_2"]);
  });

  it("ignores non-image attachment kinds", () => {
    const rows = [
      {
        role: "user",
        content: "doc",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_doc", kind: "document" }),
      },
    ];
    expect(collectRecentAttachmentPublicIds(rows)).toEqual([]);
  });

  it("ignores malformed metadata without throwing", () => {
    const rows = [
      {
        role: "user",
        content: "hi",
        contentBlocks: [],
        metadata: "not-an-object",
      },
      {
        role: "user",
        content: "hi2",
        contentBlocks: [],
        metadata: { attachments: "not-an-array" },
      },
      { role: "user", content: "hi3", contentBlocks: [], metadata: null },
    ];
    expect(collectRecentAttachmentPublicIds(rows)).toEqual([]);
  });
});

describe("buildHistoryMessages — bounded image replay", () => {
  it("re-attaches a real image part for the most recent user turn when resolved", () => {
    const rows = [
      {
        role: "user",
        content: "what is this?",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_1", name: "photo.png" }),
      },
    ];
    const resolved = new Map([["gen_1", resolvedImage()]]);

    const messages = buildHistoryMessages(rows, resolved);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(Array.isArray(messages[0]!.content)).toBe(true);
    const parts = messages[0]!.content as Array<{
      type: string;
      text?: string;
      mediaType?: string;
    }>;
    expect(parts.find((p) => p.type === "text")?.text).toBe("what is this?");
    expect(parts.find((p) => p.type === "image")?.mediaType).toBe("image/png");
  });

  it("falls back to a text placeholder for the most recent turn when the image isn't in resolvedImages", () => {
    const rows = [
      {
        role: "user",
        content: "what is this?",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_1", name: "photo.png" }),
      },
    ];
    // No resolvedImages passed — simulates the asset failing to resolve.
    const messages = buildHistoryMessages(rows);

    expect(messages).toHaveLength(1);
    expect(typeof messages[0]!.content).toBe("string");
    expect(messages[0]!.content).toBe(
      "what is this?\n[attached image: photo.png]",
    );
  });

  it("uses a text placeholder for a turn OUTSIDE the recent-2 window even when resolvedImages has the id", () => {
    const rows = [
      {
        role: "user",
        content: "third",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_3" }),
      },
      {
        role: "user",
        content: "second",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_2" }),
      },
      {
        role: "user",
        content: "first — the old attachment",
        contentBlocks: [],
        metadata: attachmentMeta({ publicId: "gen_1", name: "old.png" }),
      },
    ];
    // Even if the caller (incorrectly) resolved gen_1's bytes, the 3rd-back
    // turn must NOT replay them — only the newest 2 user turns ever do.
    const resolved = new Map([
      ["gen_3", resolvedImage()],
      ["gen_2", resolvedImage()],
      ["gen_1", resolvedImage()],
    ]);

    const messages = buildHistoryMessages(rows, resolved);

    // Chronological: first, second, third.
    expect(messages[0]!.content).toBe(
      "first — the old attachment\n[attached image: old.png]",
    );
    expect(Array.isArray(messages[1]!.content)).toBe(true); // second: recent
    expect(Array.isArray(messages[2]!.content)).toBe(true); // third: recent
  });

  it("mixes resolved and unresolved attachments within one turn", () => {
    const rows = [
      {
        role: "user",
        content: "compare these",
        contentBlocks: [],
        metadata: attachmentMeta(
          { publicId: "gen_ok", name: "ok.png" },
          { publicId: "gen_missing", name: "missing.png" },
        ),
      },
    ];
    const resolved = new Map([["gen_ok", resolvedImage()]]);

    const messages = buildHistoryMessages(rows, resolved);
    const parts = messages[0]!.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
    expect(parts.find((p) => p.type === "text")?.text).toBe(
      "compare these\n[attached image: missing.png]",
    );
  });

  it("does not affect assistant/system rows or attachment-free user rows", () => {
    const rows = [
      { role: "assistant", content: "answer", contentBlocks: [] },
      {
        role: "user",
        content: "plain question",
        contentBlocks: [],
        metadata: {},
      },
    ];
    const messages = buildHistoryMessages(rows, new Map());
    expect(messages.map((m) => m.content)).toEqual([
      "plain question",
      "answer",
    ]);
  });
});
