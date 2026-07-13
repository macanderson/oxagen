import { describe, expect, it } from "vitest";
import {
  type ConditionGroup,
  type ConditionLeaf,
  conditionTreeSchema,
  evaluateConditionNode,
  evaluateTriggerConditions,
  exceedsMaxDepth,
  legacyConditionsToTree,
  operatorExpectsArray,
  operatorRequiresValue,
  operatorsForDataType,
  resolveConditionTree,
} from "./trigger-conditions";

const leaf = (
  property: string,
  operator: ConditionLeaf["operator"],
  value?: ConditionLeaf["value"],
): ConditionLeaf => ({
  kind: "condition",
  id: `${property}-${operator}`,
  property,
  operator,
  value,
});

const group = (
  combinator: "and" | "or",
  children: ConditionGroup["children"],
): ConditionGroup => ({
  kind: "group",
  id: `g-${combinator}`,
  combinator,
  children,
});

describe("evaluateConditionNode — leaf operators", () => {
  it("eq matches strings and numbers with coercion", () => {
    expect(
      evaluateConditionNode(leaf("status", "eq", "merged"), {
        status: "merged",
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(leaf("status", "eq", "merged"), { status: "open" }),
    ).toBe(false);
    expect(evaluateConditionNode(leaf("count", "eq", 3), { count: "3" })).toBe(
      true,
    );
  });

  it("neq is the negation of eq (and false when property missing)", () => {
    expect(
      evaluateConditionNode(leaf("status", "neq", "open"), {
        status: "merged",
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(leaf("status", "neq", "merged"), {
        status: "merged",
      }),
    ).toBe(false);
    expect(evaluateConditionNode(leaf("status", "neq", "open"), {})).toBe(
      false,
    );
  });

  it("numeric comparisons gt/gte/lt/lte", () => {
    expect(evaluateConditionNode(leaf("n", "gt", 10), { n: 11 })).toBe(true);
    expect(evaluateConditionNode(leaf("n", "gt", 10), { n: 10 })).toBe(false);
    expect(evaluateConditionNode(leaf("n", "gte", 10), { n: 10 })).toBe(true);
    expect(evaluateConditionNode(leaf("n", "lt", 10), { n: 9 })).toBe(true);
    expect(evaluateConditionNode(leaf("n", "lte", 10), { n: 10 })).toBe(true);
    expect(
      evaluateConditionNode(leaf("n", "gt", 10), { n: "not-a-number" }),
    ).toBe(false);
  });

  it("contains works on strings and arrays", () => {
    expect(
      evaluateConditionNode(leaf("title", "contains", "fix"), {
        title: "hotfix release",
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(leaf("labels", "contains", "P0"), {
        labels: ["P0", "bug"],
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(leaf("labels", "contains", "P2"), {
        labels: ["P0", "bug"],
      }),
    ).toBe(false);
  });

  it("in / not_in over enum value lists", () => {
    expect(
      evaluateConditionNode(leaf("status", "in", ["merged", "closed"]), {
        status: "closed",
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(leaf("status", "in", ["merged", "closed"]), {
        status: "open",
      }),
    ).toBe(false);
    expect(
      evaluateConditionNode(leaf("status", "not_in", ["merged", "closed"]), {
        status: "open",
      }),
    ).toBe(true);
  });

  it("before / after compare dates", () => {
    expect(
      evaluateConditionNode(leaf("mergedAt", "after", "2026-01-01"), {
        mergedAt: "2026-07-12",
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(leaf("mergedAt", "before", "2026-01-01"), {
        mergedAt: "2026-07-12",
      }),
    ).toBe(false);
  });

  it("exists / not_exists", () => {
    expect(evaluateConditionNode(leaf("x", "exists"), { x: 0 })).toBe(true);
    expect(evaluateConditionNode(leaf("x", "exists"), { x: null })).toBe(false);
    expect(evaluateConditionNode(leaf("x", "not_exists"), {})).toBe(true);
  });

  it("changed: present-on-create semantics without previous state", () => {
    // No previousProperties → 'changed' means "property is present".
    expect(
      evaluateConditionNode(leaf("status", "changed"), { status: "merged" }),
    ).toBe(true);
    expect(evaluateConditionNode(leaf("status", "changed"), {})).toBe(false);
  });

  it("changed: real-change semantics with previous state", () => {
    expect(
      evaluateConditionNode(
        leaf("status", "changed"),
        { status: "merged" },
        { status: "open" },
      ),
    ).toBe(true);
    expect(
      evaluateConditionNode(
        leaf("status", "changed"),
        { status: "merged" },
        { status: "merged" },
      ),
    ).toBe(false);
  });
});

describe("evaluateConditionNode — boolean groups", () => {
  it("AND requires all children", () => {
    const tree = group("and", [leaf("a", "eq", 1), leaf("b", "eq", 2)]);
    expect(evaluateConditionNode(tree, { a: 1, b: 2 })).toBe(true);
    expect(evaluateConditionNode(tree, { a: 1, b: 3 })).toBe(false);
  });

  it("OR requires some child", () => {
    const tree = group("or", [leaf("a", "eq", 1), leaf("b", "eq", 2)]);
    expect(evaluateConditionNode(tree, { a: 9, b: 2 })).toBe(true);
    expect(evaluateConditionNode(tree, { a: 9, b: 9 })).toBe(false);
  });

  it("empty group matches vacuously", () => {
    expect(evaluateConditionNode(group("and", []), { anything: true })).toBe(
      true,
    );
    expect(evaluateConditionNode(group("or", []), { anything: true })).toBe(
      true,
    );
  });

  it("nested: 1 AND (2 OR 3)", () => {
    // status == merged AND (priority == P0 OR label == release-blocker)
    const tree = group("and", [
      leaf("status", "eq", "merged"),
      group("or", [
        leaf("priority", "eq", "P0"),
        leaf("label", "eq", "release-blocker"),
      ]),
    ]);
    expect(
      evaluateConditionNode(tree, {
        status: "merged",
        priority: "P0",
        label: "x",
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(tree, {
        status: "merged",
        priority: "P2",
        label: "release-blocker",
      }),
    ).toBe(true);
    expect(
      evaluateConditionNode(tree, {
        status: "merged",
        priority: "P2",
        label: "x",
      }),
    ).toBe(false);
    expect(
      evaluateConditionNode(tree, {
        status: "open",
        priority: "P0",
        label: "x",
      }),
    ).toBe(false);
  });
});

describe("resolveConditionTree + legacy normalization", () => {
  it("lifts legacy flat propertyConditions into an AND group", () => {
    const tree = legacyConditionsToTree([
      { property: "status", operator: "eq", toValue: "merged" },
      { property: "value", operator: "gt", toValue: "1000" },
    ]);
    expect(tree.combinator).toBe("and");
    expect(tree.children).toHaveLength(2);
    expect(evaluateConditionNode(tree, { status: "merged", value: 2000 })).toBe(
      true,
    );
    expect(evaluateConditionNode(tree, { status: "merged", value: 500 })).toBe(
      false,
    );
  });

  it("legacy 'changed' operator carries no value", () => {
    const tree = legacyConditionsToTree([
      { property: "status", operator: "changed" },
    ]);
    expect((tree.children[0] as ConditionLeaf).value).toBeUndefined();
  });

  it("prefers an explicit conditionTree over legacy conditions", () => {
    const config = {
      conditionTree: group("or", [leaf("a", "eq", 1)]),
      propertyConditions: [
        { property: "a", operator: "eq" as const, toValue: "999" },
      ],
    };
    expect(evaluateTriggerConditions(config, { a: 1 })).toBe(true);
  });

  it("wraps a bare leaf conditionTree in an AND group", () => {
    const resolved = resolveConditionTree({
      conditionTree: leaf("a", "eq", 1),
    });
    expect(resolved.kind).toBe("group");
    expect(resolved.children).toHaveLength(1);
  });

  it("empty/absent config matches vacuously", () => {
    expect(evaluateTriggerConditions(undefined, { a: 1 })).toBe(true);
    expect(
      evaluateTriggerConditions({ propertyConditions: [] }, { a: 1 }),
    ).toBe(true);
  });
});

describe("flagship: PR merged", () => {
  it("fires a doc-updater when a PullRequest node's status becomes merged", () => {
    // node.updated on :PullRequest, condition status eq merged, prev was open
    const config = {
      conditionTree: group("and", [leaf("status", "eq", "merged")]),
    };
    expect(
      evaluateTriggerConditions(
        config,
        { status: "merged" },
        { status: "open" },
      ),
    ).toBe(true);
    expect(
      evaluateTriggerConditions(config, { status: "open" }, { status: "open" }),
    ).toBe(false);
  });
});

describe("operator metadata (UI-driving)", () => {
  it("enum offers eq/neq/in/not_in and no numeric operators", () => {
    const ops = operatorsForDataType("enum");
    expect(ops).toContain("in");
    expect(ops).not.toContain("gt");
  });

  it("number offers threshold operators", () => {
    expect(operatorsForDataType("number")).toContain("gte");
  });

  it("unknown dataType falls back to defaults", () => {
    expect(operatorsForDataType(undefined)).toEqual([
      "eq",
      "neq",
      "changed",
      "exists",
      "not_exists",
    ]);
  });

  it("value requirement and arity helpers", () => {
    expect(operatorRequiresValue("changed")).toBe(false);
    expect(operatorRequiresValue("eq")).toBe(true);
    expect(operatorExpectsArray("in")).toBe(true);
    expect(operatorExpectsArray("eq")).toBe(false);
  });
});

describe("schema + depth guard", () => {
  it("accepts a valid nested tree", () => {
    const tree = group("and", [
      leaf("status", "eq", "merged"),
      group("or", [leaf("p", "eq", "P0")]),
    ]);
    expect(conditionTreeSchema.safeParse(tree).success).toBe(true);
  });

  it("rejects an over-deep tree", () => {
    let node: ConditionGroup = group("and", [leaf("a", "eq", 1)]);
    for (let i = 0; i < 8; i += 1) node = group("and", [node]);
    expect(exceedsMaxDepth(node)).toBe(true);
    expect(conditionTreeSchema.safeParse(node).success).toBe(false);
  });
});
