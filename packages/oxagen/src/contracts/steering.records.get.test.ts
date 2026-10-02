import { describe, expect, it } from "vitest";
import { steeringRecordsGet } from "./steering.records.get";

describe("get_record contract", () => {
  it("is a console read the app may bind", () => {
    expect(steeringRecordsGet.name).toBe("get_record");
    expect(steeringRecordsGet.mutates).toBe(false);
    expect(steeringRecordsGet.noBillingGate).toBe(true);
    expect(steeringRecordsGet.scoped).toBe(true);
  });

  it("takes one id and answers a published or an appended record, discriminated by source", () => {
    expect(steeringRecordsGet.input.safeParse({}).success).toBe(false);
    const appended = steeringRecordsGet.output.parse({
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
      steeringRecordsGet.output.safeParse({ source: "graph", record: {} })
        .success,
    ).toBe(false);
  });
});
