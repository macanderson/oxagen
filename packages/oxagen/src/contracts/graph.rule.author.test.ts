import { describe, expect, it } from "vitest";
import { assistantAsk } from "./assistant.ask";
import {
  GRAPH_RULE_NOTE_MAX_CHARS,
  graphRuleAuthor,
  graphRuleSchema,
} from "./graph.rule.author";

const RULE = {
  relationshipType: "OWNS_ACCOUNT",
  start: { label: "Person", source: "hubspot" },
  end: { label: "Account", source: "stripe" },
};

describe("author_graph_rule contract", () => {
  it("takes a rule across two sources and defaults to a new conversation", () => {
    expect(graphRuleAuthor.input.parse({ rule: RULE })).toEqual({
      rule: RULE,
      conversationId: null,
    });
  });

  it("accepts a plugin id as a source", () => {
    const rule = {
      ...RULE,
      end: { label: "Account", source: "oxagen/stripe-billing" },
    };
    expect(graphRuleSchema.safeParse(rule).success).toBe(true);
  });

  it("takes no goal from the caller, so the server writes the test", () => {
    const parsed = graphRuleAuthor.input.safeParse({
      rule: RULE,
      goal: { statement: "the model said it wrote something" },
    });
    expect(parsed.success).toBe(false);
  });

  it("stays off the agent surface, as ask_assistant does", () => {
    expect(graphRuleAuthor.surfaces).not.toContain("agent");
    expect(assistantAsk.surfaces).not.toContain("agent");
  });

  it("declares the roles and billing terms of ask_assistant", () => {
    expect(graphRuleAuthor.defaultRoles).toEqual(assistantAsk.defaultRoles);
    expect(graphRuleAuthor.noBillingGate).toBe(true);
  });

  it("refuses a rule within one source, a bad type, label or source, and a long note (negative)", () => {
    const refused = [
      { rule: { ...RULE, end: { label: "Account", source: "hubspot" } } },
      { rule: { ...RULE, relationshipType: "owns account" } },
      { rule: { ...RULE, start: { label: "Per`son", source: "hubspot" } } },
      { rule: { ...RULE, start: { label: "Person", source: "HubSpot" } } },
      { rule: { ...RULE, start: { label: "Person", source: "a/b/c" } } },
      { rule: { ...RULE, extra: true } },
      { rule: RULE, note: "x".repeat(GRAPH_RULE_NOTE_MAX_CHARS + 1) },
      { rule: RULE, note: "   " },
    ];
    for (const input of refused) {
      expect(graphRuleAuthor.input.safeParse(input).success).toBe(false);
    }
  });
});
