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

describe("author_graph_rule input bounds", () => {
  const withStart = (start: Record<string, unknown>) => ({
    rule: { ...RULE, start },
  });
  const accepts = (input: unknown) =>
    graphRuleAuthor.input.safeParse(input).success;

  it("accepts a label of 63 characters and refuses 64 (negative)", () => {
    expect(
      accepts(withStart({ label: `P${"a".repeat(62)}`, source: "hubspot" })),
    ).toBe(true);
    expect(
      accepts(withStart({ label: `P${"a".repeat(63)}`, source: "hubspot" })),
    ).toBe(false);
  });

  it("refuses a label that does not start with a letter (negative)", () => {
    for (const label of ["1Person", "_Person", "", "Per son", "Person:X"]) {
      expect(accepts(withStart({ label, source: "hubspot" }))).toBe(false);
    }
  });

  it("accepts source segments of 63 characters and refuses 64 (negative)", () => {
    const s63 = "s".repeat(63);
    const s64 = "s".repeat(64);
    expect(
      accepts(withStart({ label: "Person", source: `${s63}/${s63}` })),
    ).toBe(true);
    expect(accepts(withStart({ label: "Person", source: s64 }))).toBe(false);
    expect(
      accepts(withStart({ label: "Person", source: `${s63}/${s64}` })),
    ).toBe(false);
  });

  it("refuses a source that is empty, leads with a separator, or ends in a slash (negative)", () => {
    for (const source of [
      "",
      "-hubspot",
      "_hubspot",
      "hubspot/",
      "/hubspot",
      "hub spot",
    ]) {
      expect(accepts(withStart({ label: "Person", source }))).toBe(false);
    }
  });

  it("refuses a relationship type past 63 characters or not upper case (negative)", () => {
    expect(
      accepts({ rule: { ...RULE, relationshipType: `R${"_".repeat(62)}` } }),
    ).toBe(true);
    expect(
      accepts({ rule: { ...RULE, relationshipType: `R${"_".repeat(63)}` } }),
    ).toBe(false);
    expect(
      accepts({ rule: { ...RULE, relationshipType: "owns_account" } }),
    ).toBe(false);
  });

  it("refuses an extra key on either end (negative)", () => {
    expect(
      accepts(withStart({ label: "Person", source: "hubspot", id: 1 })),
    ).toBe(false);
  });

  it("reports a same-source rule on end.source", () => {
    const parsed = graphRuleAuthor.input.safeParse({
      rule: { ...RULE, end: { label: "Account", source: "hubspot" } },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path)).toEqual([
      ["rule", "end", "source"],
    ]);
  });

  it("accepts a note at the cap and trims it", () => {
    const atCap = "x".repeat(GRAPH_RULE_NOTE_MAX_CHARS);
    expect(accepts({ rule: RULE, note: atCap })).toBe(true);
    expect(
      graphRuleAuthor.input.parse({ rule: RULE, note: "  Join on email.  " })
        .note,
    ).toBe("Join on email.");
  });

  it("takes a conversation as a uuid or a public id, and a turnId only as a uuid", () => {
    const uuid = "0192d4a8-7c1e-7a00-8000-0000000000c1";
    expect(accepts({ rule: RULE, conversationId: uuid })).toBe(true);
    expect(accepts({ rule: RULE, conversationId: "cnv_01k9x2tq" })).toBe(true);
    expect(accepts({ rule: RULE, conversationId: "conv-1" })).toBe(false);
    expect(accepts({ rule: RULE, turnId: uuid })).toBe(true);
    expect(accepts({ rule: RULE, turnId: "turn-1" })).toBe(false);
  });
});
