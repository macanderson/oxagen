// index.test.ts: the package exports every evaluator from its root.
import { describe, expect, it } from "vitest";
import * as pkg from "../index";
import * as evaluators from "./index";

describe("the evaluators barrel", () => {
  it("exports every evaluator entry point", () => {
    expect(typeof evaluators.evaluateCheck).toBe("function");
    expect(typeof evaluators.evaluateOracle).toBe("function");
    expect(typeof evaluators.evaluateCriterion).toBe("function");
    expect(typeof evaluators.mergeGatewayRecords).toBe("function");
    expect(typeof evaluators.denyRuleMatches).toBe("function");
    expect(evaluators.DAY_ONE_ORACLE_CLASSES).toHaveLength(7);
  });

  it("is re-exported from the package root", () => {
    expect(pkg.evaluateCriterion).toBe(evaluators.evaluateCriterion);
    expect(pkg.evaluateCheck).toBe(evaluators.evaluateCheck);
    expect(pkg.WITNESS_REASONS).toBe(evaluators.WITNESS_REASONS);
  });
});
