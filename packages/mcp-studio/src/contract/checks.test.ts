import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "@oxagen/oxagen/steering-repo/json-schema";
import { atMostOne, dependentRequired, uniqueList, withChecks } from "./checks";

const schema = withChecks(
  z
    .object({
      mode: z.enum(["a", "b"]),
      first: z.string().optional(),
      second: z.string().optional(),
      third: z.string().optional(),
    })
    .strict(),
  [
    { kind: "require", when: { field: "mode", is: "b" }, fields: ["first"] },
    atMostOne(["first", "second", "third"]),
    dependentRequired("third", ["mode"]),
    { issues: () => [], json: undefined },
  ],
);

describe("withChecks", () => {
  it("runs S0 field rules and custom checks in one refinement", () => {
    expect(schema.safeParse({ mode: "a" }).success).toBe(true);
    const missing = schema.safeParse({ mode: "b" });
    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([["first"]]);
    const both = schema.safeParse({ mode: "a", first: "x", second: "y", third: "z" });
    expect(both.error?.issues.map((issue) => issue.message)).toEqual([
      "set only one of first, second, third",
      "set only one of first, second, third",
    ]);
  });

  it("publishes every check that has JSON Schema, and skips the rest", () => {
    const json = toJsonSchema(schema) as { allOf: unknown[] };
    expect(json.allOf).toHaveLength(3);
    expect(json.allOf[1]).toEqual({
      not: {
        anyOf: [
          { required: ["first", "second"] },
          { required: ["first", "third"] },
          { required: ["second", "third"] },
        ],
      },
    });
    expect(json.allOf[2]).toEqual({ dependentRequired: { third: ["mode"] } });
  });

  it("publishes no allOf when zod alone runs every check", () => {
    const quiet = withChecks(z.object({ a: z.string() }), [{ issues: () => [], json: undefined }]);
    expect(toJsonSchema(quiet)).not.toHaveProperty("allOf");
  });
});

describe("dependentRequired", () => {
  it("asks for each missing field", () => {
    const check = dependentRequired("selection", ["field", "operation"]);
    expect(check.issues({ selection: "{ id }" }).map((issue) => issue.path)).toEqual([
      ["field"],
      ["operation"],
    ]);
    expect(check.issues({})).toEqual([]);
  });
});

describe("uniqueList", () => {
  it("refuses a repeated item and a list past its limit", () => {
    const list = uniqueList(z.string(), "impacts", 2);
    expect(list.safeParse(["a", "b"]).success).toBe(true);
    expect(list.safeParse(["a", "a"]).error?.issues[0]?.message).toBe('impacts lists "a" twice');
    expect(list.safeParse(["a", "b", "c"]).success).toBe(false);
    expect(toJsonSchema(list)).toMatchObject({ uniqueItems: true, maxItems: 2 });
    expect(toJsonSchema(uniqueList(z.string(), "tags"))).not.toHaveProperty("maxItems");
  });
});
