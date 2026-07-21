import { describe, it, expect } from "vitest";
import { LABEL_PATTERN, assertSafeLabel } from "./label-pattern";

describe("LABEL_PATTERN", () => {
  it("accepts valid Neo4j labels (PascalCase, snake, mixed case)", () => {
    for (const ok of [
      "Billing",
      "Payment",
      "PII",
      "billing",
      "Node_1",
      "Code",
      "A",
    ]) {
      expect(LABEL_PATTERN.test(ok)).toBe(true);
      expect(() => assertSafeLabel(ok)).not.toThrow();
    }
  });

  it("rejects empty, leading-digit, and Cypher-injection strings", () => {
    for (const bad of [
      "",
      "1Bad",
      "has space",
      "`]->()-[:x",
      "a:b",
      "Foo-Bar",
      "Foo.Bar",
      "x".repeat(64),
    ]) {
      expect(LABEL_PATTERN.test(bad)).toBe(false);
      expect(() => assertSafeLabel(bad)).toThrow();
    }
  });
});
