import { describe, expect, it } from "vitest";
import { agentMemoryImportCommit } from "./agent.memory.import.commit";
import { getCapability } from "../registry";

const oneDraft = {
  lesson: "Never push to main.",
  kind: "constraint" as const,
  weight: "critical" as const,
};

describe("agent.memory.import.commit capability", () => {
  it("is registered in the capability registry", () => {
    expect(getCapability("agent.memory.import.commit")).toBeDefined();
  });

  it("is a scoped, sync memory capability with deny default", () => {
    expect(agentMemoryImportCommit.mode).toBe("sync");
    expect(agentMemoryImportCommit.scoped).toBe(true);
    expect(agentMemoryImportCommit.defaultEffect).toBe("deny");
    expect(agentMemoryImportCommit.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("allows org Owner/Admin and workspace Owner/Member", () => {
    expect(agentMemoryImportCommit.defaultRoles).toMatchObject({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("parses a minimal valid input and applies draft defaults", () => {
    const parsed = agentMemoryImportCommit.input.parse({ drafts: [oneDraft] });
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.drafts[0]?.source).toBe("user");
    expect(parsed.drafts[0]?.nodeRef).toBe("user-memory");
  });

  it("rejects an empty drafts array", () => {
    expect(() => agentMemoryImportCommit.input.parse({ drafts: [] })).toThrow();
  });

  it("rejects more than 200 drafts", () => {
    const drafts = Array.from({ length: 201 }, () => oneDraft);
    expect(() => agentMemoryImportCommit.input.parse({ drafts })).toThrow();
  });

  it("validates positional output results with nullable memoryId/error", () => {
    const parsed = agentMemoryImportCommit.output.parse({
      results: [
        { lesson: "A", ok: true, memoryId: "m_1", error: null },
        { lesson: "B", ok: false, memoryId: null, error: "write failed" },
      ],
      imported: 1,
      failed: 1,
    });
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]?.memoryId).toBe("m_1");
    expect(parsed.results[1]?.error).toBe("write failed");
    expect(parsed.imported).toBe(1);
    expect(parsed.failed).toBe(1);
  });
});
