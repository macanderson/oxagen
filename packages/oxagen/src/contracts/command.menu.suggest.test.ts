import { describe, it, expect } from "vitest";
import { commandMenuSuggest } from "./command.menu.suggest";

describe("command.menu.suggest contract", () => {
  it("is registered on api and agent surfaces", () => {
    expect(commandMenuSuggest.name).toBe("suggest_commands");
    expect(commandMenuSuggest.surfaces).toContain("api");
    expect(commandMenuSuggest.surfaces).toContain("agent");
  });

  it("is scoped and defaults to deny", () => {
    expect(commandMenuSuggest.scoped).toBe(true);
    expect(commandMenuSuggest.defaultEffect).toBe("deny");
  });

  it("allows all workspace roles including Viewer", () => {
    expect(commandMenuSuggest.defaultRoles.workspace?.Owner).toBe("allow");
    expect(commandMenuSuggest.defaultRoles.workspace?.Member).toBe("allow");
    expect(commandMenuSuggest.defaultRoles.workspace?.Viewer).toBe("allow");
  });

  it("parses a minimal valid input (only route required)", () => {
    const parsed = commandMenuSuggest.input.parse({
      route: "/acme/prod/activity/runs/run_4221",
    });
    expect(parsed.route).toBe("/acme/prod/activity/runs/run_4221");
    expect(parsed.routeParams).toEqual({});
    expect(parsed.queryParams).toEqual({});
    expect(parsed.recentEntities).toEqual([]);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.locale).toBe("en");
  });

  it("parses a full input with pageEntity", () => {
    const parsed = commandMenuSuggest.input.parse({
      route: "/acme/prod/activity/runs/run_4221",
      routeParams: { runId: "run_4221" },
      queryParams: { tab: "trace" },
      pageEntity: {
        kind: "run",
        id: "aex_abc123",
        publicId: "run_4221",
        label: "Run #4221",
        summary: "Run of playbook churn-investigate. Status: failed.",
      },
      recentEntities: [
        { kind: "playbook", id: "plb_1", label: "Churn Investigate" },
      ],
      capabilities: ["run_capability_chain", "query_audit_log"],
      locale: "en-US",
    });
    expect(parsed.pageEntity?.kind).toBe("run");
    expect(parsed.pageEntity?.summary).toBe(
      "Run of playbook churn-investigate. Status: failed.",
    );
    expect(parsed.locale).toBe("en-US");
  });

  it("rejects pageEntity.summary exceeding 500 chars", () => {
    expect(
      commandMenuSuggest.input.safeParse({
        route: "/x",
        pageEntity: { kind: "run", id: "aex_1", summary: "a".repeat(501) },
      }).success,
    ).toBe(false);
  });

  it("rejects recentEntities with more than 5 items", () => {
    expect(
      commandMenuSuggest.input.safeParse({
        route: "/x",
        recentEntities: Array.from({ length: 6 }, (_, i) => ({
          kind: "run",
          id: `aex_${i}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("parses a valid output with 3 suggestions", () => {
    const out = commandMenuSuggest.output.parse({
      suggestions: [
        {
          text: "Summarize this run's failure",
          category: "investigate",
          confidence: 0.92,
        },
        {
          text: "Show similar failed runs today",
          category: "investigate",
          confidence: 0.8,
        },
        {
          text: "Open source playbook in editor",
          category: "configure",
          confidence: 0.7,
        },
      ],
    });
    expect(out.suggestions).toHaveLength(3);
    expect(out.suggestions[0]?.category).toBe("investigate");
    expect(out.suggestions[0]?.confidence).toBe(0.92);
  });

  it("parses an empty suggestions array (opt-out / fallback case)", () => {
    const out = commandMenuSuggest.output.parse({ suggestions: [] });
    expect(out.suggestions).toHaveLength(0);
  });

  it("rejects suggestions with more than 5 items", () => {
    expect(
      commandMenuSuggest.output.safeParse({
        suggestions: Array.from({ length: 6 }, (_, i) => ({
          text: `Suggestion ${i}`,
          category: "analyze",
          confidence: 0.5,
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects a suggestion with confidence > 1", () => {
    expect(
      commandMenuSuggest.output.safeParse({
        suggestions: [
          { text: "Do something", category: "create", confidence: 1.5 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a suggestion with text shorter than 3 chars", () => {
    expect(
      commandMenuSuggest.output.safeParse({
        suggestions: [{ text: "ok", category: "create", confidence: 0.5 }],
      }).success,
    ).toBe(false);
  });
});
