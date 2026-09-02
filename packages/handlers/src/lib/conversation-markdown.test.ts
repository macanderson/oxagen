import { describe, expect, it } from "vitest";
import {
  branchToExportMessages,
  conversationToMarkdown,
  exportFilename,
  formatDuration,
  messageToBlocks,
  roleLabel,
  walkActiveBranch,
  type ConversationExportModel,
  type ExportMessageRow,
} from "./conversation-markdown";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function row(
  overrides: Partial<ExportMessageRow> & { id: string },
): ExportMessageRow {
  return {
    parentMessageId: null,
    role: "user",
    content: "",
    contentBlocks: [],
    metadata: {},
    createdAt: new Date("2026-07-01T10:00:00.000Z"),
    ...overrides,
  };
}

function model(
  overrides: Partial<ConversationExportModel> = {},
): ConversationExportModel {
  return {
    title: "Quarterly Planning",
    createdAt: new Date("2026-06-30T09:00:00.000Z"),
    exportedAt: new Date("2026-07-07T12:00:00.000Z"),
    orgName: "Acme",
    workspaceName: "Growth",
    messages: [],
    totalMessageCount: 0,
    ...overrides,
  };
}

// ── walkActiveBranch ──────────────────────────────────────────────────────────

describe("walkActiveBranch", () => {
  it("returns empty for no rows", () => {
    expect(walkActiveBranch([], null)).toEqual([]);
  });

  it("walks a linear chain from the active leaf to the root, in order", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", parentMessageId: "a", role: "assistant" }),
      row({ id: "c", parentMessageId: "b" }),
    ];
    expect(walkActiveBranch(rows, "c").map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("follows the active branch, excluding the abandoned sibling", () => {
    const rows = [
      row({ id: "root" }),
      row({ id: "old", parentMessageId: "root", role: "assistant" }),
      row({ id: "new", parentMessageId: "root", role: "assistant" }),
      row({ id: "reply", parentMessageId: "new" }),
    ];
    const path = walkActiveBranch(rows, "reply").map((r) => r.id);
    expect(path).toEqual(["root", "new", "reply"]);
    expect(path).not.toContain("old");
  });

  it("falls back to the newest leaf when no active leaf is recorded", () => {
    const rows = [
      row({ id: "a", createdAt: new Date("2026-07-01T10:00:00.000Z") }),
      row({
        id: "b",
        parentMessageId: "a",
        createdAt: new Date("2026-07-01T10:01:00.000Z"),
      }),
    ];
    expect(walkActiveBranch(rows, null).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("falls back when the recorded leaf id is missing from the rows", () => {
    const rows = [row({ id: "a" }), row({ id: "b", parentMessageId: "a" })];
    expect(walkActiveBranch(rows, "ghost").map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("terminates on a parent cycle instead of looping forever", () => {
    // Corrupt data: a → b → a. Nothing in the schema forbids it, and an
    // unguarded walk would spin while the path array grew without bound.
    const rows = [
      row({ id: "a", parentMessageId: "b" }),
      row({ id: "b", parentMessageId: "a" }),
    ];
    expect(walkActiveBranch(rows, "b").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("terminates on a self-parenting row", () => {
    const rows = [row({ id: "solo", parentMessageId: "solo" })];
    expect(walkActiveBranch(rows, "solo").map((r) => r.id)).toEqual(["solo"]);
  });
});

// ── messageToBlocks ───────────────────────────────────────────────────────────

describe("messageToBlocks", () => {
  it("falls back to flat content when contentBlocks is empty", () => {
    const blocks = messageToBlocks(row({ id: "a", content: "hello" }));
    expect(blocks).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("maps text, reasoning, tool-call, and code-execute blocks", () => {
    const blocks = messageToBlocks(
      row({
        id: "a",
        role: "assistant",
        contentBlocks: [
          {
            type: "reasoning",
            reasoningId: "r1",
            text: "thinking…",
            durationMs: 2100,
          },
          { type: "text", text: "Here you go." },
          {
            type: "tool-call",
            toolCallId: "t1",
            capability: "search_graph",
            status: "success",
            durationMs: 420,
            resultPreview: { hits: 3 },
          },
          {
            type: "code-execute",
            toolCallId: "t2",
            language: "python",
            code: "print(1)",
            status: "success",
          },
        ],
      }),
    );
    expect(blocks).toEqual([
      { kind: "reasoning", text: "thinking…", durationMs: 2100 },
      { kind: "text", text: "Here you go." },
      {
        kind: "tool",
        capability: "search_graph",
        status: "success",
        durationMs: 420,
        resultPreview: '{"hits":3}',
      },
      { kind: "code", language: "python", code: "print(1)" },
    ]);
  });

  it("omits oversized tool result previews (>200 chars)", () => {
    const blocks = messageToBlocks(
      row({
        id: "a",
        contentBlocks: [
          {
            type: "tool-call",
            capability: "x",
            status: "success",
            resultPreview: { data: "y".repeat(400) },
          },
        ],
      }),
    );
    expect(blocks[0]).toMatchObject({ kind: "tool", capability: "x" });
    expect(
      (blocks[0] as { resultPreview?: string }).resultPreview,
    ).toBeUndefined();
  });

  it("skips unknown block types and malformed entries", () => {
    const blocks = messageToBlocks(
      row({
        id: "a",
        content: "fallback not used",
        contentBlocks: [
          { type: "plan", planId: "p1" },
          null,
          "junk",
          { type: "text", text: "kept" },
        ],
      }),
    );
    expect(blocks).toEqual([{ kind: "text", text: "kept" }]);
  });

  it("appends validated metadata attachments and drops malformed ones", () => {
    const blocks = messageToBlocks(
      row({
        id: "a",
        content: "see attached",
        metadata: {
          attachments: [
            { name: "report.pdf", url: "/api/v1/assets/gen_1", kind: "pdf" },
            { name: 42 },
          ],
        },
      }),
    );
    expect(blocks).toEqual([
      { kind: "text", text: "see attached" },
      { kind: "attachment", name: "report.pdf", url: "/api/v1/assets/gen_1" },
    ]);
  });
});

// ── branchToExportMessages ────────────────────────────────────────────────────

describe("branchToExportMessages", () => {
  it("drops messages that normalize to zero blocks", () => {
    const messages = branchToExportMessages([
      row({ id: "a", content: "hi" }),
      row({ id: "b", content: "   ", contentBlocks: [] }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "hi" });
  });
});

// ── conversationToMarkdown ────────────────────────────────────────────────────

describe("conversationToMarkdown", () => {
  it("renders title, metadata, role headings, and separators", () => {
    const md = conversationToMarkdown(
      model({
        messages: branchToExportMessages([
          row({ id: "a", role: "user", content: "What is our Q3 plan?" }),
          row({ id: "b", role: "assistant", content: "Ship the wedge." }),
        ]),
        totalMessageCount: 2,
      }),
    );
    expect(md).toContain("# Quarterly Planning");
    expect(md).toContain("_Exported from Oxagen on 2026-07-07T12:00:00.000Z_");
    expect(md).toContain("- **Organization:** Acme");
    expect(md).toContain("- **Workspace:** Growth");
    expect(md).toContain("- **Messages:** 2");
    expect(md).toContain("## You");
    expect(md).toContain("## Assistant");
    expect(md).toContain("What is our Q3 plan?");
    expect(md).toContain("Ship the wedge.");
    expect(md).toContain("\n---\n");
    // No branch note when all messages are on the active path.
    expect(md).not.toContain("across branches");
  });

  it("renders reasoning as a collapsible details block with duration", () => {
    const md = conversationToMarkdown(
      model({
        messages: branchToExportMessages([
          row({
            id: "a",
            role: "assistant",
            contentBlocks: [
              { type: "reasoning", text: "hmm", durationMs: 1500 },
              { type: "text", text: "done" },
            ],
          }),
        ]),
        totalMessageCount: 1,
      }),
    );
    expect(md).toContain("<details>");
    expect(md).toContain("<summary>Reasoning (1.5s)</summary>");
    expect(md).toContain("hmm");
    expect(md).toContain("</details>");
  });

  it("renders tool calls as compact fenced summaries and code with language fences", () => {
    const md = conversationToMarkdown(
      model({
        messages: branchToExportMessages([
          row({
            id: "a",
            role: "assistant",
            contentBlocks: [
              {
                type: "tool-call",
                capability: "query_ontology",
                status: "success",
                durationMs: 90,
              },
              { type: "code-execute", language: "ts", code: "const x = 1;" },
            ],
          }),
        ]),
        totalMessageCount: 1,
      }),
    );
    expect(md).toContain(
      "```\ntool: query_ontology · status: success · duration: 90ms\n```",
    );
    expect(md).toContain("```ts\nconst x = 1;\n```");
  });

  it("renders attachments as markdown links", () => {
    const md = conversationToMarkdown(
      model({
        messages: branchToExportMessages([
          row({
            id: "a",
            content: "see file",
            metadata: {
              attachments: [{ name: "spec.md", url: "/api/v1/assets/gen_9" }],
            },
          }),
        ]),
        totalMessageCount: 1,
      }),
    );
    expect(md).toContain("**Attachment:** [spec.md](/api/v1/assets/gen_9)");
  });

  it("adds a branch note when the conversation has more rows than the active path", () => {
    const md = conversationToMarkdown(
      model({
        messages: branchToExportMessages([row({ id: "a", content: "hi" })]),
        totalMessageCount: 5,
      }),
    );
    expect(md).toContain("5 messages across branches");
    expect(md).toContain("active branch (1 messages)");
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

describe("roleLabel / formatDuration / exportFilename", () => {
  it("labels roles", () => {
    expect(roleLabel("user")).toBe("You");
    expect(roleLabel("assistant")).toBe("Assistant");
    expect(roleLabel("system")).toBe("System");
  });

  it("formats durations", () => {
    expect(formatDuration(90)).toBe("90ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(undefined)).toBeNull();
  });

  it("derives slugged filenames with the export date", () => {
    const when = new Date("2026-07-07T12:00:00.000Z");
    expect(exportFilename("Quarterly Planning!", when, "md")).toBe(
      "quarterly-planning-2026-07-07.md",
    );
    expect(exportFilename("  ", when, "pdf")).toBe(
      "conversation-2026-07-07.pdf",
    );
    const long = exportFilename("word ".repeat(40), when, "md");
    expect(long.length).toBeLessThanOrEqual(60 + "-2026-07-07.md".length);
  });
});
