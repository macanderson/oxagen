/**
 * Contract test for open_studio_review (lane M11, ADR-224).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioReviewOpen } from "./tool.studio.review.open";

describe("open_studio_review is registered as declared", () => {
  it("is scoped, mutates, needs approval as an agent action, and audits the server folder", () => {
    const cap = getCapability("open_studio_review");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.agent?.requiresApproval).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.audit).toEqual({
      targetKind: "tool_server_folder",
      targetIdField: "server",
    });
  });
});

describe("open_studio_review", () => {
  it("accepts a server with or without a revision", () => {
    expect(toolStudioReviewOpen.input.parse({ server: "ledger" })).toEqual({
      server: "ledger",
    });
    expect(
      toolStudioReviewOpen.input.parse({ server: "ledger", revision: 2 }),
    ).toEqual({ server: "ledger", revision: 2 });
  });

  it("refuses revision 0, the built-in server, and an unknown field", () => {
    for (const input of [
      { server: "ledger", revision: 0 },
      { server: "builtin" },
      { server: "ledger", branch: "main" },
    ]) {
      expect(toolStudioReviewOpen.input.safeParse(input).success).toBe(false);
    }
  });

  it("returns the steering PR with its changes, token total, and findings", () => {
    const classification = {
      risk: "low",
      sideEffect: "read",
      egress: "third_party",
      impacts: [],
    };
    const output = {
      number: 12,
      url: "https://github.com/acme/steering/pull/12",
      branch: "tools/ledger",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      imported: ["search"],
      removed: ["delete_all"],
      reclassified: [
        {
          tool: "search",
          before: classification,
          after: { ...classification, risk: "medium" },
        },
      ],
      tokens: { definitions: 120, budget: 4000 },
      findings: [
        {
          rule: "description_length",
          level: "warning",
          tool: "search",
          field: "description",
          message: "The description is empty",
          fix: "Describe what the tool does",
        },
      ],
    };
    expect(toolStudioReviewOpen.output.parse(output)).toEqual(output);
    expect(
      toolStudioReviewOpen.output.safeParse({
        ...output,
        tokens: { definitions: 120, budget: 0 },
      }).success,
    ).toBe(false);
  });
});
