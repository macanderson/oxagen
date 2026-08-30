import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "./errors";

describe("isUniqueViolation", () => {
  it("detects a bare postgres unique_violation (top-level code)", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("detects a drizzle-wrapped unique_violation (code on .cause)", () => {
    // drizzle-orm 0.45 wraps driver errors; the SQLSTATE lives on .cause.code.
    // This is the regression the bare `err.code` check missed.
    const wrapped = new Error("Failed query: insert into ...") as Error & {
      cause: unknown;
    };
    wrapped.cause = { code: "23505" };
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("detects a deeply nested cause chain", () => {
    expect(isUniqueViolation({ cause: { cause: { code: "23505" } } })).toBe(
      true,
    );
  });

  it("returns false for a non-unique-violation error", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false); // foreign_key_violation
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  it("narrows to a specific constraint when one is supplied", () => {
    expect(
      isUniqueViolation(
        { code: "23505", constraint_name: "organizations_slug_idx" },
        "organizations_slug_idx",
      ),
    ).toBe(true);
    expect(
      isUniqueViolation(
        { code: "23505", constraint: "organizations_slug_idx" },
        "organizations_slug_idx",
      ),
    ).toBe(true);
    // Right code, wrong constraint → not a match.
    expect(
      isUniqueViolation(
        { code: "23505", constraint_name: "other_idx" },
        "organizations_slug_idx",
      ),
    ).toBe(false);
  });

  it("does not loop forever on a self-referential cause chain", () => {
    const a = { code: "x" } as { code: string; cause?: unknown };
    a.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
