/**
 * Contract test for list_tool_versions (#2958).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolVersionList } from "./tool.version.list";

describe("list_tool_versions is registered as declared", () => {
  it("is scoped, mutates=false and is never a governed action", () => {
    const cap = getCapability("list_tool_versions");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
  });
});

describe("list_tool_versions", () => {
  it("defaults the page size and accepts a category filter", () => {
    expect(toolVersionList.input.parse({})).toEqual({ limit: 50 });
    expect(
      toolVersionList.input.parse({ category: "moves_money", limit: 5 }),
    ).toEqual({ category: "moves_money", limit: 5 });
  });

  it("accepts a server filter alone and beside a category, and refuses an empty one", () => {
    expect(toolVersionList.input.parse({ serverId: "mcs_linear" })).toEqual({
      serverId: "mcs_linear",
      limit: 50,
    });
    expect(
      toolVersionList.input.parse({
        serverId: "mcs_linear",
        category: "moves_money",
      }),
    ).toEqual({ serverId: "mcs_linear", category: "moves_money", limit: 50 });
    expect(toolVersionList.input.safeParse({ serverId: "" }).success).toBe(
      false,
    );
  });

  it("refuses a category outside the tag pattern", () => {
    expect(toolVersionList.input.safeParse({ category: "Moves" }).success).toBe(
      false,
    );
  });

  it("carries an unclassified version with a null classification and null calls", () => {
    const parsed = toolVersionList.output.parse({
      items: [
        {
          id: "tlv_1",
          toolId: "tol_1",
          slug: "create_pull_request",
          name: "create_pull_request",
          description: null,
          version: 3,
          source: "mcp",
          serverId: "mcs_1",
          capabilityId:
            "mcp.0192d4a8-7c1e-7a00-8000-000000000001.create_pull_request",
          readOnly: false,
          riskGrade: "high",
          classification: null,
          classifiedAt: null,
          schemaOrigin: "imported",
          schemaDigest: "a".repeat(64),
          enabled: true,
          gate: { kind: "killed_class", switchId: "emd_1" },
          calls30d: null,
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(parsed.items[0]?.classification).toBeNull();
    expect(parsed.items[0]?.gate.kind).toBe("killed_class");
  });
});
