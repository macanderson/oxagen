// mapping.test.ts: how each part of a GraphQL schema maps to a tool (lane M2;
// mcp-studio-spec, Mapping: GraphQL), and the note import adds each time it
// cuts or leaves something out.
import { describe, expect, it } from "vitest";
import { TOOL_KEY_MAX } from "../contract/primitives";
import type { ImportResult } from "../model/import-result";
import { upstreamToolSchema, type GraphqlRequest, type UpstreamTool } from "../model/upstream-tool";
import { importGraphql } from "./index";

/** The import of the SDL. Every tool must pass the UpstreamTool contract. */
async function imported(sdl: string): Promise<ImportResult> {
  const result = await importGraphql({ sdl });
  for (const tool of result.tools) upstreamToolSchema.parse(tool);
  return result;
}

function toolOf(result: ImportResult, name: string): UpstreamTool {
  const tool = result.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`The import has no tool named ${name}.`);
  return tool;
}

function requestOf(result: ImportResult, name: string): GraphqlRequest {
  const { request } = toolOf(result, name);
  if (request.kind !== "graphql") throw new Error(`The ${name} tool has a ${request.kind} request.`);
  return request;
}

const CONNECTION_PAGING = {
  style: "connection",
  input: "after",
  next: "pageInfo.endCursor",
  has_more: "pageInfo.hasNextPage",
  items: "edges",
};

describe("scalar, enum, list, and object results", () => {
  const SDL = `
    enum Mood { HAPPY SAD }
    type Profile { mood: Mood }
    type Query {
      count: Int!
      tags: [String!]
      mood: Mood
      profile: Profile
    }
  `;

  it("gives a scalar or enum result no selection set and no outputSchema", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "count")).toStrictEqual({
      name: "count",
      inputSchema: { type: "object", properties: {} },
      request: { kind: "graphql", operation_type: "query", field: "Query.count", arguments: [] },
    });
    expect(toolOf(result, "mood")).toStrictEqual({
      name: "mood",
      inputSchema: { type: "object", properties: {} },
      request: { kind: "graphql", operation_type: "query", field: "Query.mood", arguments: [] },
    });
  });

  it("returns a list result as items", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "tags").selection).toBeUndefined();
    expect(toolOf(result, "tags").outputSchema).toStrictEqual({
      type: "object",
      properties: { items: { type: ["array", "null"], items: { type: "string" } } },
    });
  });

  it("selects an object's fields and allows null where the schema allows it", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "profile").selection).toBe("{ mood }");
    expect(toolOf(result, "profile").outputSchema).toStrictEqual({
      type: "object",
      properties: { mood: { type: ["string", "null"], enum: ["HAPPY", "SAD", null] } },
    });
  });

  it("lists nothing and notes nothing for a schema with no mutation or subscription", async () => {
    const result = await imported(SDL);
    expect(result.tools.map((tool) => tool.name)).toStrictEqual(["count", "tags", "mood", "profile"]);
    expect(result.listed).toStrictEqual([]);
    expect(result.notes).toStrictEqual([]);
  });
});

describe("connections", () => {
  const SDL = `
    type Query {
      feed(after: String): PostConnection!
      top(first: Int): PostConnection
      author: Author
      tags(after: String, first: Int): TagConnection!
      vaults(after: String): VaultConnection
      near: NotList
      bare: NoCursor
    }
    type PostConnection { edges: [PostEdge] pageInfo: PageInfo! }
    type PostEdge { cursor: String node: Post }
    type Post { id: ID! }
    type PageInfo { hasNextPage: Boolean! endCursor: String }
    type Author { name: String posts: PostConnection }
    type TagConnection { edges: [TagEdge!]! pageInfo: PageInfo! }
    type TagEdge { node: String! }
    type VaultConnection { edges: [VaultEdge] pageInfo: PageInfo! }
    type VaultEdge { node: Vault }
    type Vault { secret(key: String!): String }
    type NotList { edges: Edge pageInfo: PageInfo }
    type Edge { node: Post }
    type NoCursor { edges: [Edge] pageInfo: HalfInfo }
    type HalfInfo { hasNextPage: Boolean! }
  `;
  const PAGE_SELECTION = "{ edges { cursor node { id } } pageInfo { hasNextPage endCursor } }";

  it("selects a root connection's edges, nodes, and pageInfo, and pages it by after", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "feed")).toStrictEqual({
      name: "feed",
      inputSchema: { type: "object", properties: { after: { type: "string" } } },
      outputSchema: {
        type: "object",
        properties: {
          edges: {
            type: ["array", "null"],
            items: {
              type: ["object", "null"],
              properties: {
                cursor: { type: ["string", "null"] },
                node: { type: ["object", "null"], properties: { id: { type: "string" } } },
              },
            },
          },
          pageInfo: {
            type: "object",
            properties: { hasNextPage: { type: "boolean" }, endCursor: { type: ["string", "null"] } },
          },
        },
      },
      paging: CONNECTION_PAGING,
      request: {
        kind: "graphql",
        operation_type: "query",
        field: "Query.feed",
        arguments: [{ name: "after", type: "String", property: "after" }],
        selection: PAGE_SELECTION,
      },
    });
  });

  it("names first as the page size when the field takes it", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "tags").paging).toStrictEqual({ ...CONNECTION_PAGING, limit: "first" });
    expect(requestOf(result, "tags").selection).toBe("{ edges { node } pageInfo { hasNextPage endCursor } }");
    expect(toolOf(result, "tags").outputSchema).toMatchObject({
      properties: { edges: { type: "array", items: { type: "object", properties: { node: { type: "string" } } } } },
    });
  });

  it("selects __typename on a node with no field it can select", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "vaults").paging).toStrictEqual(CONNECTION_PAGING);
    expect(requestOf(result, "vaults").selection).toBe(
      "{ edges { node { __typename } } pageInfo { hasNextPage endCursor } }",
    );
  });

  it("gives a connection with no after argument no paging, with a note", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "top").paging).toBeUndefined();
    expect(requestOf(result, "top").selection).toBe(PAGE_SELECTION);
    expect(result.notes).toStrictEqual([
      {
        tool: "top",
        message: "Query.top returns a connection but takes no after argument, so the tool has no paging.",
      },
    ]);
  });

  it("stops at a connection below the root", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "author").selection).toBe("{ name }");
    expect(toolOf(result, "author").paging).toBeUndefined();
  });

  it("does not page a type whose edges are not a list or whose pageInfo has no endCursor", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "near").selection).toBe("{ pageInfo { hasNextPage endCursor } }");
    expect(toolOf(result, "near").paging).toBeUndefined();
    expect(requestOf(result, "bare").selection).toBe("{ pageInfo { hasNextPage } }");
    expect(toolOf(result, "bare").paging).toBeUndefined();
  });
});

describe("descriptions, deprecation, custom scalars, and defaults", () => {
  const SDL = `
    """A point in time."""
    scalar Instant @specifiedBy(url: "https://example.com/instant")
    scalar Blob
    scalar Json @specifiedBy(url: "https://example.com/json")
    enum Mode { FAST SLOW }
    input Opts {
      mode: Mode = FAST
      tags: [String!]
    }
    type Event {
      "When it happened."
      at: Instant
    }
    type Query {
      "Old lookup."
      old(id: ID!, "The legacy key." key: String @deprecated(reason: "Use id.")): Int @deprecated(reason: "Use new.")
      at(when: Instant!, raw: Blob, data: Json, limit: Int! = 5, opts: Opts = { mode: SLOW }): Instant
      event: Event
    }
  `;

  it("carries a deprecated field and argument, with a note", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "old")).toStrictEqual({
      name: "old",
      description: "Old lookup.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          key: { type: "string", description: "The legacy key.", deprecated: true },
        },
        required: ["id"],
      },
      deprecated: true,
      request: {
        kind: "graphql",
        operation_type: "query",
        field: "Query.old",
        arguments: [
          { name: "id", type: "ID!", property: "id" },
          { name: "key", type: "String", property: "key" },
        ],
      },
    });
    expect(result.notes).toStrictEqual([{ tool: "old", message: "Query.old is deprecated: Use new." }]);
  });

  it("maps custom scalars, enums, input objects, and defaults to JSON Schema", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "at")).toStrictEqual({
      name: "at",
      inputSchema: {
        type: "object",
        properties: {
          when: { description: "A point in time.\n\nFormat: https://example.com/instant" },
          raw: { type: "string" },
          data: { description: "Format: https://example.com/json" },
          limit: { type: "integer", default: 5 },
          opts: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["FAST", "SLOW"], default: "FAST" },
              tags: { type: "array", items: { type: "string" } },
            },
            default: { mode: "SLOW" },
          },
        },
        required: ["when"],
      },
      request: {
        kind: "graphql",
        operation_type: "query",
        field: "Query.at",
        arguments: [
          { name: "when", type: "Instant!", property: "when" },
          { name: "raw", type: "Blob", property: "raw" },
          { name: "data", type: "Json", property: "data" },
          { name: "limit", type: "Int", property: "limit" },
          { name: "opts", type: "Opts", property: "opts" },
        ],
      },
    });
  });

  it("puts a field's description ahead of its type's", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "event").selection).toBe("{ at }");
    expect(toolOf(result, "event").outputSchema).toStrictEqual({
      type: "object",
      properties: {
        at: { description: "When it happened.\n\nA point in time.\n\nFormat: https://example.com/instant" },
      },
    });
  });
});

describe("input schema cuts", () => {
  const BIG_FIELDS = Array.from({ length: 500 }, (_, index) => `f${index + 1}`);
  const SDL = `
    input A { b: B }
    input B { c: C }
    input C { d: D }
    input D { e: E }
    input E { v: Int }
    input Node { child: Node v: Int }
    input Big { ${BIG_FIELDS.map((name) => `${name}: Int`).join(" ")} }
    input Small { v: Int }
    type Query {
      deep(a: A): Int
      tree(n: Node, m: Node): Int
      wide(big: Big, small: Small): Int
    }
  `;

  /** Node expanded the given number of levels, then cut. */
  const node = (levels: number): Record<string, unknown> =>
    levels === 0
      ? { type: "object" }
      : { type: "object", properties: { child: node(levels - 1), v: { type: "integer" } } };

  it("cuts an input object nested more than 4 deep", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "deep").inputSchema).toStrictEqual({
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: {
                c: { type: "object", properties: { d: { type: "object", properties: { e: { type: "object" } } } } },
              },
            },
          },
        },
      },
    });
    expect(toolOf(result, "tree").inputSchema).toStrictEqual({
      type: "object",
      properties: { n: node(4), m: node(4) },
    });
  });

  it("cuts input objects once the schema reaches 500 properties", async () => {
    const result = await imported(SDL);
    expect(toolOf(result, "wide").inputSchema).toStrictEqual({
      type: "object",
      properties: {
        big: { type: "object", properties: Object.fromEntries(BIG_FIELDS.map((name) => [name, { type: "integer" }])) },
        small: { type: "object" },
      },
    });
  });

  it("notes each cut once per tool", async () => {
    const result = await imported(SDL);
    expect(result.notes).toStrictEqual([
      {
        tool: "deep",
        message: 'The input E is nested more than 4 input objects deep, so its schema is cut to { "type": "object" }.',
      },
      {
        tool: "tree",
        message: 'The input Node is nested more than 4 input objects deep, so its schema is cut to { "type": "object" }.',
      },
      {
        tool: "wide",
        message: 'The input schema reached 500 properties, so Small is cut to { "type": "object" }.',
      },
    ]);
  });
});

describe("tool names", () => {
  const LONG = "a".repeat(TOOL_KEY_MAX + 9);
  const LONG_TOO = `${"a".repeat(TOOL_KEY_MAX)}${"b".repeat(9)}`;
  const CUT = "a".repeat(TOOL_KEY_MAX);
  const CUT_2 = `${"a".repeat(TOOL_KEY_MAX - 2)}_2`;
  const SDL = `
    type Query {
      getUser: Int
      get_user: Int
      _private: Int
      _1st: Int
      HTTPRequest: Int
      ${LONG}: Int
      ${LONG_TOO}: Int
    }
  `;

  it("names each tool from its field in snake case, with a suffix on a clash", async () => {
    const result = await imported(SDL);
    expect(result.tools.map((tool) => tool.name)).toStrictEqual([
      "get_user",
      "get_user_2",
      "private",
      "field_1st",
      "http_request",
      CUT,
      CUT_2,
    ]);
    expect(requestOf(result, "get_user_2").field).toBe("Query.get_user");
    expect(requestOf(result, CUT_2).field).toBe(`Query.${LONG_TOO}`);
  });

  it("notes each name it cuts or changes", async () => {
    const result = await imported(SDL);
    expect(result.notes).toStrictEqual([
      { tool: "get_user_2", message: "Another root field already takes get_user, so Query.get_user takes get_user_2." },
      {
        tool: CUT,
        message: `Query.${LONG} suggests a name longer than ${TOOL_KEY_MAX} characters, so it is cut to ${CUT}.`,
      },
      {
        tool: CUT_2,
        message: `Query.${LONG_TOO} suggests a name longer than ${TOOL_KEY_MAX} characters, so it is cut to ${CUT}.`,
      },
      { tool: CUT_2, message: `Another root field already takes ${CUT}, so Query.${LONG_TOO} takes ${CUT_2}.` },
    ]);
  });
});

describe("unions", () => {
  const SDL = `
    union Pet = Cat | Dog | Ghost
    type Cat { name: String lives: Int }
    type Dog { name: String! bark: String }
    type Ghost { secret(key: String!): String }
    type Query { pet: Pet }
  `;

  it("selects each member in a fragment and leaves out a field whose type clashes", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "pet").selection).toBe("{ __typename ... on Cat { name lives } ... on Dog { bark } }");
    expect(toolOf(result, "pet").outputSchema).toStrictEqual({
      type: "object",
      properties: {
        __typename: { type: "string", enum: ["Cat", "Dog", "Ghost"] },
        name: { type: ["string", "null"] },
        lives: { type: ["integer", "null"] },
        bark: { type: ["string", "null"] },
      },
    });
    expect(result.notes).toStrictEqual([
      {
        tool: "pet",
        message:
          "Dog.name is left out of the Pet selection, because another member returns String under that name.",
      },
    ]);
  });
});

describe("the 20-field cap", () => {
  const fields = (count: number): string =>
    Array.from({ length: count }, (_, index) => `f${index + 1}: Int`).join(" ");
  const names = (count: number): string => Array.from({ length: count }, (_, index) => `f${index + 1}`).join(" ");
  const SDL = `
    type Inner { v: Int }
    type Wide { ${fields(25)} child: Inner }
    type Tall { ${fields(19)} a: Inner b: Inner }
    type Query { wide: Wide tall: Tall }
  `;

  it("keeps the first 20 fields, scalar and enum fields first, with a note", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "wide").selection).toBe(`{ ${names(20)} }`);
    expect(requestOf(result, "tall").selection).toBe(`{ ${names(19)} a { v } }`);
    expect(result.notes).toStrictEqual([
      { tool: "wide", message: "The selection set on Wide keeps its first 20 fields, scalar and enum fields first." },
      { tool: "tall", message: "The selection set on Tall keeps its first 20 fields, scalar and enum fields first." },
    ]);
  });
});

describe("a result with no field to select", () => {
  const SDL = `
    type Locked {
      secret(key: String!): String
      old: Int @deprecated
    }
    interface Hidden { secret(key: String!): String }
    type Query { locked: Locked! hidden: Hidden }
  `;

  it("selects only __typename, with a note", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "locked").selection).toBe("{ __typename }");
    expect(toolOf(result, "locked").outputSchema).toStrictEqual({
      type: "object",
      properties: { __typename: { type: "string", enum: ["Locked"] } },
    });
    expect(requestOf(result, "hidden").selection).toBe("{ __typename }");
    expect(toolOf(result, "hidden").outputSchema).toStrictEqual({
      type: "object",
      properties: { __typename: { type: "string" } },
    });
    expect(result.notes).toStrictEqual([
      { tool: "locked", message: "No field of Locked can be selected, so the selection set asks only for __typename." },
      { tool: "hidden", message: "No field of Hidden can be selected, so the selection set asks only for __typename." },
    ]);
  });
});

describe("a selection set over 16,384 characters", () => {
  const LONG = Array.from({ length: 20 }, (_, index) => `f${index + 1}_${"x".repeat(896)}`);
  const SDL = `
    type Leafy { ${LONG.map((name) => `${name}: Int`).join(" ")} }
    type Deep { id: ID! big: Leafy }
    type PageInfo { hasNextPage: Boolean! endCursor: String }
    type LeafyEdge { node: Leafy }
    type LeafyConnection { totalCount: Int edges: [LeafyEdge] pageInfo: PageInfo }
    type Query {
      deep: Deep
      flat: Leafy
      pages(first: Int, after: String): LeafyConnection
    }
  `;
  const DEPTH_2 = "The selection set to depth 2 is longer than 16,384 characters, so it stops at depth 1.";
  const DEPTH_1 = "The selection set at depth 1 is still longer than 16,384 characters, so it selects only __typename.";
  const NO_PAGING = "Paging needs edges and pageInfo in the selection set, so the tool has no paging.";

  it("stops at depth 1, then at __typename, and drops paging it cannot keep", async () => {
    const result = await imported(SDL);
    expect(requestOf(result, "deep").selection).toBe("{ id }");
    expect(toolOf(result, "deep").outputSchema).toStrictEqual({
      type: "object",
      properties: { id: { type: "string" } },
    });
    expect(requestOf(result, "flat").selection).toBe("{ __typename }");
    expect(toolOf(result, "flat").outputSchema).toStrictEqual({
      type: "object",
      properties: { __typename: { type: "string", enum: ["Leafy"] } },
    });
    expect(requestOf(result, "pages").selection).toBe("{ totalCount }");
    expect(toolOf(result, "pages").paging).toBeUndefined();
    expect(toolOf(result, "pages").outputSchema).toStrictEqual({
      type: "object",
      properties: { totalCount: { type: ["integer", "null"] } },
    });
    expect(result.notes).toStrictEqual([
      { tool: "deep", message: DEPTH_2 },
      { tool: "flat", message: DEPTH_2 },
      { tool: "flat", message: DEPTH_1 },
      { tool: "pages", message: DEPTH_2 },
      { tool: "pages", message: NO_PAGING },
    ]);
  });
});
