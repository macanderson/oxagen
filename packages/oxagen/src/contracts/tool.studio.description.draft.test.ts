/**
 * Contract test for draft_studio_description (mcp-studio-spec, lane M9).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioDescriptionDraft } from "./tool.studio.description.draft";

describe("draft_studio_description is registered as declared", () => {
  it("is scoped, reads only, keeps the billing gate, and grants the Studio roles", () => {
    const cap = getCapability("draft_studio_description");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    // The call spends model tokens, so the billing gate stays on.
    expect(cap?.noBillingGate).toBeUndefined();
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
    expect(cap?.audit).toBeUndefined();
  });
});

describe("draft_studio_description input", () => {
  it("takes a server and a tool and refuses anything else", () => {
    const input = { server: "billing", tool: "list_charges" };
    expect(toolStudioDescriptionDraft.input.parse(input)).toEqual(input);
    for (const bad of [
      { server: "billing" },
      { tool: "list_charges" },
      { server: "builtin", tool: "list_charges" },
      { server: "billing", tool: "" },
      { server: "billing", tool: "x".repeat(129) },
      { server: "billing", tool: "list_charges", description: "Lists charges." },
    ]) {
      expect(toolStudioDescriptionDraft.input.safeParse(bad).success).toBe(false);
    }
  });
});

describe("draft_studio_description output", () => {
  it("carries a suggestion of 1 to 1,024 characters", () => {
    const out = { server: "billing", tool: "list_charges", description: "List one customer's charges." };
    expect(toolStudioDescriptionDraft.output.parse(out)).toEqual(out);
    expect(toolStudioDescriptionDraft.output.safeParse({ ...out, description: "x".repeat(1024) }).success).toBe(true);
    for (const description of ["", "x".repeat(1025)]) {
      expect(toolStudioDescriptionDraft.output.safeParse({ ...out, description }).success).toBe(false);
    }
  });
});
