// index.test.ts: the support desk fixture imports to the golden tools, from
// SDL and from introspection, and a schema import cannot read is refused with
// a reason.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildClientSchema, buildSchema, introspectionFromSchema, printSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { documentHash } from "../contract/hashes";
import { formatJson } from "../contract/json";
import { DEFINITION_BYTES_MAX } from "../model/definition-limits";
import { upstreamToolSchema } from "../model/upstream-tool";
import { importGraphql } from "./index";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const SDL = readFileSync(`${FIXTURES}graphql/schema.graphql`, "utf8");
const GOLDEN_TEXT = readFileSync(`${FIXTURES}expected/graphql/upstream.json`, "utf8");
const GOLDEN = JSON.parse(GOLDEN_TEXT) as unknown as { name: string }[];

/** The value as JSON reads it back, so undefined and prototypes drop out. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe("importGraphql with the support desk SDL", () => {
  it("makes one tool per Query and Mutation field, in schema order", async () => {
    const result = await importGraphql({ sdl: SDL });
    expect(result.tools.map((tool) => tool.name)).toStrictEqual([
      "node",
      "issue",
      "issues",
      "search",
      "viewer",
      "create_issue",
      "update_issue",
      "delete_issue",
      "add_comment",
    ]);
    expect(GOLDEN.map((tool) => tool.name)).toStrictEqual(result.tools.map((tool) => tool.name));
  });

  it.each(GOLDEN.map((tool, index): [string, number] => [tool.name, index]))(
    "matches the golden %s tool",
    async (_name, index) => {
      const result = await importGraphql({ sdl: SDL });
      expect(asJson(result.tools[index])).toStrictEqual(GOLDEN[index]);
    },
  );

  it("writes the golden file byte for byte", async () => {
    const result = await importGraphql({ sdl: SDL });
    expect(formatJson(result.tools)).toBe(GOLDEN_TEXT);
  });

  it("returns tools the UpstreamTool contract accepts", async () => {
    const result = await importGraphql({ sdl: SDL });
    for (const tool of result.tools) expect(() => upstreamToolSchema.parse(tool)).not.toThrow();
  });

  it("pins the connection's selection set and paging", async () => {
    const result = await importGraphql({ sdl: SDL });
    const issues = result.tools.find((tool) => tool.name === "issues");
    expect(issues?.paging).toStrictEqual({
      style: "connection",
      input: "after",
      next: "pageInfo.endCursor",
      has_more: "pageInfo.hasNextPage",
      items: "edges",
      limit: "first",
    });
    expect(issues?.request).toMatchObject({
      selection:
        "{ totalCount edges { cursor node { id number title body state priority labels createdAt closedAt } } pageInfo { hasNextPage endCursor } }",
    });
  });

  it("lists the subscription and makes no tool of it", async () => {
    const result = await importGraphql({ sdl: SDL });
    expect(result.listed).toStrictEqual([
      {
        name: "Subscription.issueChanged",
        kind: "subscription",
        reason: "A subscription streams events, so it never becomes a tool.",
      },
    ]);
    expect(result.tools.map((tool) => tool.name)).not.toContain("issue_changed");
  });

  it("hashes the SDL as written and writes no files", async () => {
    const result = await importGraphql({ sdl: SDL });
    expect(result.notes).toStrictEqual([]);
    expect(result.files).toStrictEqual([]);
    expect(result.environments).toStrictEqual([]);
    expect(result.auth).toStrictEqual([]);
    expect(result.descriptor_set).toBeUndefined();
    expect(result.document_hash).toBe(documentHash(SDL));
  });
});

describe("importGraphql with an introspection result", () => {
  const introspection = introspectionFromSchema(buildSchema(SDL));

  it("makes the same tools as the SDL", async () => {
    const fromSdl = await importGraphql({ sdl: SDL });
    const fromIntrospection = await importGraphql({ introspection });
    expect(asJson(fromIntrospection.tools)).toStrictEqual(asJson(fromSdl.tools));
    expect(fromIntrospection.listed).toStrictEqual(fromSdl.listed);
    expect(fromIntrospection.notes).toStrictEqual([]);
  });

  it("writes the printed schema as schema.graphql and hashes that text", async () => {
    const result = await importGraphql({ introspection });
    const text = printSchema(buildClientSchema(introspection));
    expect(result.files).toStrictEqual([{ path: "schema.graphql", text }]);
    expect(text).toContain("type Query {");
    expect(result.document_hash).toBe(documentHash(text));
  });

  it("takes the whole response as well as its data", async () => {
    const bare = await importGraphql({ introspection });
    const wrapped = await importGraphql({ introspection: { data: introspection } });
    expect(asJson(wrapped)).toStrictEqual(asJson(bare));
  });
});

describe("importGraphql refusals", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a response with no __schema", { data: {} }],
    ["a string", "type Query { a: Int }"],
  ])("refuses %s as an introspection result", async (_label, introspection) => {
    await expect(importGraphql({ introspection })).rejects.toThrow(
      'The introspection result has no __schema object. Pass the data of an introspection query: { "__schema": { ... } }.',
    );
  });

  it("refuses an introspection result with no types", async () => {
    await expect(importGraphql({ introspection: { __schema: {} } })).rejects.toThrow(
      "The introspection result does not describe a schema.",
    );
  });

  it("refuses an introspection result that names a type it does not describe", async () => {
    const introspection = {
      __schema: { queryType: { name: "Query" }, mutationType: null, subscriptionType: null, types: [], directives: [] },
    };
    await expect(importGraphql({ introspection })).rejects.toThrow(
      "The introspection result does not describe a schema. Invalid or incomplete schema, unknown type: Query.",
    );
  });

  it("refuses SDL with a syntax error, with its line and column", async () => {
    await expect(importGraphql({ sdl: "type Query {" })).rejects.toThrow(
      "The SDL does not describe a schema. Line 1, column 13: Syntax Error: Expected Name, found <EOF>.",
    );
  });

  it("refuses SDL that names an unknown type", async () => {
    await expect(importGraphql({ sdl: "type Query { a: Missing }" })).rejects.toThrow(
      'The SDL does not describe a schema. Unknown type "Missing".',
    );
  });

  it("refuses a schema that does not validate, with the line and column", async () => {
    const sdl = [
      "interface Named {",
      "  name: String!",
      "}",
      "type User implements Named { id: ID! }",
      "type Query { user: User }",
    ].join("\n");
    const refusal = importGraphql({ sdl });
    await expect(refusal).rejects.toThrow("The schema is not valid. Line 2, column 3: ");
    await expect(refusal).rejects.toThrow("Interface field Named.name expected but User does not provide it.");
  });

  it("refuses a schema with no Query type", async () => {
    await expect(importGraphql({ sdl: "type Mutation { a: Int }" })).rejects.toThrow(
      "The schema is not valid. Query root type must be provided.",
    );
  });

  it("refuses a schema over 25 MB before parsing it", async () => {
    const sdl = `${"#".repeat(DEFINITION_BYTES_MAX)}\ntype Query { a: Int }`;
    await expect(importGraphql({ sdl })).rejects.toThrow(
      `The schema is ${(DEFINITION_BYTES_MAX + 22).toLocaleString("en-US")} bytes. Import refuses a definition over 25 MB, so split the schema or import a smaller one.`,
    );
  });
});
