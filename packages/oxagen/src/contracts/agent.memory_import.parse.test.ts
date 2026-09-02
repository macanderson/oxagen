import { describe, expect, it } from "vitest";
import { agentMemoryImportParse } from "./agent.memory_import.parse";
import { getCapability } from "../registry";

const oneDoc = { filename: "rules.md", content: "- never push to main" };

describe("agent.memory.import.parse capability", () => {
  it("is registered in the capability registry", () => {
    expect(getCapability("parse_memory_import")).toBeDefined();
  });

  it("is a scoped, sync, read-only memory capability with deny default", () => {
    expect(agentMemoryImportParse.mode).toBe("sync");
    expect(agentMemoryImportParse.scoped).toBe(true);
    expect(agentMemoryImportParse.defaultEffect).toBe("deny");
    expect(agentMemoryImportParse.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("allows org Owner/Admin and workspace Owner/Member", () => {
    expect(agentMemoryImportParse.defaultRoles).toMatchObject({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("parses a minimal valid input (one document)", () => {
    const parsed = agentMemoryImportParse.input.parse({ documents: [oneDoc] });
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.defaultNodeRef).toBeUndefined();
  });

  it("accepts an optional defaultNodeRef", () => {
    const parsed = agentMemoryImportParse.input.parse({
      documents: [oneDoc],
      defaultNodeRef: "team:platform",
    });
    expect(parsed.defaultNodeRef).toBe("team:platform");
  });

  it("rejects an empty documents array", () => {
    expect(() =>
      agentMemoryImportParse.input.parse({ documents: [] }),
    ).toThrow();
  });

  it("rejects more than 25 documents", () => {
    const docs = Array.from({ length: 26 }, (_, i) => ({
      filename: `f${i}.md`,
      content: "x",
    }));
    expect(() =>
      agentMemoryImportParse.input.parse({ documents: docs }),
    ).toThrow();
  });

  it("rejects a document with empty content", () => {
    expect(() =>
      agentMemoryImportParse.input.parse({
        documents: [{ filename: "f.md", content: "" }],
      }),
    ).toThrow();
  });

  it("rejects a document over the 100k content cap", () => {
    expect(() =>
      agentMemoryImportParse.input.parse({
        documents: [{ filename: "big.md", content: "x".repeat(100_001) }],
      }),
    ).toThrow();
  });

  it("validates output drafts/documentCount/skipped", () => {
    const parsed = agentMemoryImportParse.output.parse({
      drafts: [
        {
          lesson: "L",
          memoryClass: "RULE",
          memoryKind: "constraint",
          enforcementScore: 80,
        },
      ],
      documentCount: 1,
      skipped: [{ filename: "empty.md", reason: "No durable rules found." }],
    });
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.drafts[0]?.memoryClass).toBe("RULE");
    expect(parsed.drafts[0]?.enforcementScore).toBe(80);
    // Output drafts get the schema defaults too.
    expect(parsed.drafts[0]?.source).toBe("user");
    expect(parsed.skipped[0]?.filename).toBe("empty.md");
  });
});
