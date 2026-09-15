import { describe, expect, it } from "vitest";
import { contextRecordsGet } from "./context.records.get";

describe("get_record contract", () => {
  it("is a console read the app may bind", () => {
    expect(contextRecordsGet.name).toBe("get_record");
    expect(contextRecordsGet.mutates).toBe(false);
    expect(contextRecordsGet.noBillingGate).toBe(true);
    expect(contextRecordsGet.scoped).toBe(true);
  });

  it("takes one id and answers a published or an appended record, discriminated by source", () => {
    expect(contextRecordsGet.input.safeParse({}).success).toBe(false);
    const appended = contextRecordsGet.output.parse({
      source: "appended",
      record: {
        id: "cta_0123456789abcdefghjkmn",
        kind: "observation",
        lineageId: "ctx.platform.safari-e2e-flake",
        statement: "The checkout suite flaked on Safari through August.",
        sharingScope: "workspace",
        recordHash: `sha256:${"b".repeat(64)}`,
        sourceRefs: ["frame:run_1/12"],
        evidenceLinks: [],
        proposalId: null,
        createdAt: "2026-09-15T00:00:00.000Z",
      },
    });
    expect(appended.source).toBe("appended");
    expect(
      contextRecordsGet.output.safeParse({ source: "graph", record: {} })
        .success,
    ).toBe(false);
  });
});
