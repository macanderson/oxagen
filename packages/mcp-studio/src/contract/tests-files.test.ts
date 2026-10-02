// A recorded call holds no credential: the header checks on a recorded HTTP
// request and response, in zod and in the JSON Schema that states them. A
// selection test names the tool that fits its task, or null when none does.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toJsonSchema } from "@oxagen/oxagen/steering-repo/json-schema";
import { recordedHttpRequestSchema, recordedHttpResponseSchema, selectionTestSchema } from "./tests-files";

const request = { method: "POST", path: "/refunds", body: { charge: "ch_1" } };
const response = { status: 200, body: { id: "re_1" } };

/** The path and message of each issue zod reports, or [] when the value parses. */
function issuesOf(result: z.SafeParseReturnType<unknown, unknown>) {
  return result.success ? [] : result.error.issues.map(({ path, message }) => ({ path, message }));
}

/** The header pattern the JSON Schema refuses, from the schema's one allOf entry. */
function refusedPattern(schema: z.ZodTypeAny): RegExp {
  const json = toJsonSchema(schema) as {
    allOf: { properties: { headers: { propertyNames: { not: { pattern: string } } } } }[];
  };
  const [entry, ...rest] = json.allOf;
  if (entry === undefined || rest.length > 0) throw new Error("expected one allOf entry");
  return new RegExp(entry.properties.headers.propertyNames.not.pattern);
}

describe("recordedHttpRequestSchema", () => {
  it.each(["authorization", "Authorization", "proxy-authorization", "Proxy-AUTHORIZATION", "cookie", "COOKIE"])(
    "refuses a %s header",
    (name) => {
      const result = recordedHttpRequestSchema.safeParse({ ...request, headers: { [name]: "secret" } });
      expect(issuesOf(result)).toStrictEqual([
        {
          path: ["headers", name],
          message: `the ${name} header is not allowed: a recorded call holds no credential`,
        },
      ]);
    },
  );

  it("accepts ordinary headers", () => {
    const headers = { "X-Request-Source": "oxagen", "idempotency-key": "k1", "Content-Type": "application/json" };
    expect(recordedHttpRequestSchema.parse({ ...request, headers })).toStrictEqual({ ...request, headers });
  });

  it("publishes the rule as a pattern that matches each refused name in any case", () => {
    const pattern = refusedPattern(recordedHttpRequestSchema);
    for (const name of ["authorization", "Proxy-Authorization", "COOKIE", "cOoKiE"]) {
      expect(pattern.test(name), name).toBe(true);
    }
    for (const name of ["X-Authorization", "authorization-id", "cookies", "set-cookie", "idempotency-key"]) {
      expect(pattern.test(name), name).toBe(false);
    }
  });
});

describe("recordedHttpResponseSchema", () => {
  it.each(["set-cookie", "Set-Cookie", "SET-COOKIE"])("refuses a %s header", (name) => {
    const result = recordedHttpResponseSchema.safeParse({ ...response, headers: { [name]: "session=abc" } });
    expect(issuesOf(result)).toStrictEqual([
      {
        path: ["headers", name],
        message: `the ${name} header is not allowed: a recorded call holds no credential`,
      },
    ]);
  });

  it("accepts ordinary headers", () => {
    const headers = { "content-type": "application/json", "X-Request-Id": "r1" };
    expect(recordedHttpResponseSchema.parse({ ...response, headers })).toStrictEqual({ ...response, headers });
  });

  it("publishes the rule as a pattern that matches Set-Cookie in any case", () => {
    const pattern = refusedPattern(recordedHttpResponseSchema);
    expect(pattern.test("Set-Cookie")).toBe(true);
    expect(pattern.test("set-cookie")).toBe(true);
    expect(pattern.test("cookie")).toBe(false);
    expect(pattern.test("set-cookie2")).toBe(false);
  });
});

describe("selectionTestSchema", () => {
  const task = "Give the customer back $40 of charge ch_3P9 because it was billed twice.";

  it("takes the full name of the tool that fits the task", () => {
    const test = { task, expect: "billing__create_refund" };
    expect(selectionTestSchema.parse(test)).toStrictEqual(test);
  });

  it("takes null for a task that no tool fits", () => {
    const test = { task: "Write a haiku about invoices.", expect: null };
    expect(selectionTestSchema.parse(test)).toStrictEqual(test);
  });

  it.each([
    ["a missing expect", { task }],
    ["an empty tool name", { task, expect: "" }],
    ["a tool named without its server", { task, expect: "create_refund" }],
    ["an empty task", { task: "", expect: null }],
    ["an extra field", { task, expect: null, note: "none fits" }],
  ])("refuses %s", (_label, test) => {
    expect(selectionTestSchema.safeParse(test).success).toBe(false);
  });

  it("says in its description that null means no tool fits", () => {
    expect(selectionTestSchema.shape.expect.description).toBe(
      "The tool that fits the task, such as billing__create_refund, or null when no tool fits.",
    );
  });
});
