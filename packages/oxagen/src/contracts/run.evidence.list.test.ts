import { describe, expect, it } from "vitest";
import { runEvidenceList } from "./run.evidence.list";
import { getCapability } from "../registry";

describe("run.evidence.list capability", () => {
  it("is registered read-only on api/mcp/cli in the run domain", () => {
    const cap = getCapability("list_run_evidence");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("run");
    expect(cap?.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(cap?.sensitivity).toBe("low");
  });

  it("defaults limit to 25", () => {
    const parsed = runEvidenceList.input.parse({});
    expect(parsed.limit).toBe(25);
  });

  it("rejects a limit over 100", () => {
    expect(() => runEvidenceList.input.parse({ limit: 101 })).toThrow();
  });

  it("rejects a non-uuid repositoryId", () => {
    expect(() =>
      runEvidenceList.input.parse({ repositoryId: "not-a-uuid" }),
    ).toThrow();
  });

  it("accepts runId, repositoryId, and an ISO cursor", () => {
    const parsed = runEvidenceList.input.parse({
      runId: "run_1",
      repositoryId: "00000000-0000-4000-8000-000000000001",
      cursor: "2026-07-20T00:00:00.000Z",
    });
    expect(parsed.runId).toBe("run_1");
    expect(parsed.cursor).toBe("2026-07-20T00:00:00.000Z");
  });

  it("parses a page output with nextCursor", () => {
    const parsed = runEvidenceList.output.parse({
      manifests: [
        {
          id: "rem_1",
          runId: "run_1",
          attemptId: null,
          evidenceAuthority: "client_attested",
          manifestDigest: "f".repeat(64),
          createdAt: "2026-07-20T00:00:00.000Z",
          changeCount: 3,
          frameCount: 2,
        },
      ],
      nextCursor: "2026-07-20T00:00:00.000Z",
    });
    expect(parsed.manifests).toHaveLength(1);
    expect(parsed.manifests[0]?.evidenceAuthority).toBe("client_attested");
    expect(parsed.nextCursor).toBe("2026-07-20T00:00:00.000Z");
  });
});
