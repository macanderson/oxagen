/**
 * Contract test for list_studio_findings (mcp-studio-spec, lane M9).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioFindingsList } from "./tool.studio.findings.list";

describe("list_studio_findings is registered as declared", () => {
  it("is scoped, reads only, skips the billing gate, and grants the Studio roles", () => {
    const cap = getCapability("list_studio_findings");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
    expect(cap?.audit).toBeUndefined();
  });
});

describe("list_studio_findings input", () => {
  it("takes a server name and refuses anything else", () => {
    expect(toolStudioFindingsList.input.parse({ server: "billing" })).toEqual({ server: "billing" });
    for (const input of [{}, { server: "builtin" }, { server: "Billing" }, { server: "billing", revision: 1 }]) {
      expect(toolStudioFindingsList.input.safeParse(input).success).toBe(false);
    }
  });
});

describe("list_studio_findings output", () => {
  const finding = {
    rule: "over_definition_budget",
    level: "warning",
    tool: null,
    field: "exposure.mode",
    message: "The one imported tool costs about 900 tokens on every request, over the definition_budget of 1.",
    fix: "Set exposure.mode to search.",
  };

  it("carries the basis, the revision, the tokens, and the findings", () => {
    const draft = {
      server: "billing",
      basis: "draft",
      revision: 4,
      tokens: { definitions: 900, budget: 1 },
      findings: [finding],
    };
    expect(toolStudioFindingsList.output.parse(draft)).toEqual(draft);

    const published = { ...draft, basis: "published", revision: null, findings: [] };
    expect(toolStudioFindingsList.output.parse(published)).toEqual(published);
  });

  it("refuses an unknown basis, an unknown level, and a zero revision", () => {
    const base = {
      server: "billing",
      basis: "draft",
      revision: 1,
      tokens: { definitions: 0, budget: 8000 },
      findings: [],
    };
    for (const output of [
      { ...base, basis: "branch" },
      { ...base, revision: 0 },
      { ...base, findings: [{ ...finding, level: "fatal" }] },
      { ...base, tokens: { definitions: 0, budget: 0 } },
    ]) {
      expect(toolStudioFindingsList.output.safeParse(output).success).toBe(false);
    }
  });
});
