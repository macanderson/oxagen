import { describe, expect, it } from "vitest";
import { SEARCH_ROW_LIMIT, searchRowSchema, toolsSearch } from "./tools.search";

describe("search_tools contract", () => {
  it("is a console read on the api, mcp and agent surfaces", () => {
    expect(toolsSearch.mutates).toBe(false);
    expect(toolsSearch.noBillingGate).toBe(true);
    expect(toolsSearch.scoped).toBe(true);
    expect(toolsSearch.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("defaults to an empty query over every kind and bounds the query", () => {
    expect(toolsSearch.input.parse({})).toEqual({ query: "" });
    expect(
      toolsSearch.input.parse({ query: "budget", kinds: ["tool", "run"] }),
    ).toEqual({ query: "budget", kinds: ["tool", "run"] });
    expect(toolsSearch.input.safeParse({ kinds: [] }).success).toBe(false);
    expect(toolsSearch.input.safeParse({ kinds: ["node"] }).success).toBe(
      false,
    );
    expect(
      toolsSearch.input.safeParse({ query: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("rows carry an id and no href, and the page holds at most eight", () => {
    const row = {
      kind: "run",
      id: "arun_0123456789abcdef012345",
      label: "arun_0123456789abcdef012345",
      contextLine: "sealed · acme.core.reviewer",
    };
    expect(searchRowSchema.parse(row)).toEqual(row);
    expect(
      searchRowSchema.safeParse({ ...row, href: "/acme/core/runs/x" }).success,
    ).toBe(false);
    expect(
      toolsSearch.output.safeParse({
        rows: Array.from({ length: SEARCH_ROW_LIMIT + 1 }, () => row),
      }).success,
    ).toBe(false);
  });
});
