/**
 * tools-catalog.test.ts — unit coverage for the pure client-side filter logic
 * behind the Studio → Tools catalog (search + domain + risk filters).
 *
 * Kept dependency-free (no React Testing Library render) since `filterTools`
 * is a pure function — no need to mount the Sheet/Select/table to prove the
 * matching rules.
 */
import { describe, it, expect } from "vitest";
import { filterTools } from "./tools-catalog";
import type { AgentToolRow } from "@/lib/studio/tools";

function tool(overrides: Partial<AgentToolRow> = {}): AgentToolRow {
  return {
    name: "repo.pr.get",
    description: "Fetch a pull request by number.",
    domain: "repo",
    category: "vcs",
    riskLevel: "low",
    requiresApproval: false,
    external: false,
    ...overrides,
  };
}

describe("filterTools", () => {
  const tools: AgentToolRow[] = [
    tool({ name: "repo.pr.get", domain: "repo", category: "vcs", riskLevel: "low" }),
    tool({
      name: "billing.invoice.create",
      domain: "billing",
      category: "stripe",
      riskLevel: "high",
      requiresApproval: true,
      description: "Create a Stripe invoice.",
    }),
    tool({
      name: "slack.message.send",
      domain: "slack",
      category: null,
      riskLevel: "medium",
      external: true,
      description: "Post a message to a Slack channel.",
    }),
  ];

  it("returns every row when query is empty and filters are 'all'", () => {
    expect(filterTools(tools, "", "all", "all")).toHaveLength(3);
  });

  it("matches by tool name (case-insensitive)", () => {
    const result = filterTools(tools, "PR.get", "all", "all");
    expect(result.map((t) => t.name)).toEqual(["repo.pr.get"]);
  });

  it("matches by domain", () => {
    const result = filterTools(tools, "billing", "all", "all");
    expect(result.map((t) => t.name)).toEqual(["billing.invoice.create"]);
  });

  it("matches by description text", () => {
    const result = filterTools(tools, "slack channel", "all", "all");
    expect(result.map((t) => t.name)).toEqual(["slack.message.send"]);
  });

  it("filters by exact domain when a domain filter is set", () => {
    const result = filterTools(tools, "", "slack", "all");
    expect(result.map((t) => t.name)).toEqual(["slack.message.send"]);
  });

  it("filters by risk level", () => {
    const result = filterTools(tools, "", "all", "high");
    expect(result.map((t) => t.name)).toEqual(["billing.invoice.create"]);
  });

  it("combines search, domain, and risk filters", () => {
    const result = filterTools(tools, "invoice", "billing", "high");
    expect(result.map((t) => t.name)).toEqual(["billing.invoice.create"]);
  });

  it("returns an empty array when no tool matches", () => {
    expect(filterTools(tools, "nonexistent", "all", "all")).toHaveLength(0);
    expect(filterTools(tools, "", "repo", "high")).toHaveLength(0);
  });

  it("treats a null category as non-matching for category-text search", () => {
    const result = filterTools(tools, "vcs", "all", "all");
    expect(result.map((t) => t.name)).toEqual(["repo.pr.get"]);
  });
});
