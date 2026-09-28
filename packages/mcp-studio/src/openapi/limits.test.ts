// limits.test.ts: the node limits, lowered so a small document reaches each one.
import { describe, expect, it, vi } from "vitest";
import { importOpenApi, type OpenApiInput } from ".";
import { OpenApiImportError } from "./errors";
import type { JsonRecord } from "./json";
import type * as Limits from "./limits";

vi.mock("./limits", async (importOriginal) => ({
  ...(await importOriginal<typeof Limits>()),
  PARSED_NODES_MAX: 3000,
  EXPANSION_NODES_MAX: 1500,
  TOOL_NODES_SOFT_MAX: 60,
}));

/** The OpenApiImportError the import rejects with. */
async function refusal(pending: Promise<unknown>): Promise<OpenApiImportError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenApiImportError);
    return error as OpenApiImportError;
  }
  throw new Error("expected the import to reject");
}

function input(document: unknown): OpenApiInput {
  return { files: [{ path: "openapi.json", text: JSON.stringify(document) }], entry: "openapi.json", overlay: undefined };
}

function json(schema: unknown): JsonRecord {
  return { "200": { description: "OK", content: { "application/json": { schema } } } };
}

/** `n` string properties named p0 to p(n-1). Each costs two nodes when expanded. */
function strings(n: number): JsonRecord {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string" }]));
}

describe("the node limits", () => {
  it("refuses a document that parses to more nodes than the limit", async () => {
    const document = { openapi: "3.1.0", info: { title: "Big", version: "1" }, paths: {}, "x-big": Array<number>(4000).fill(0) };
    const error = await refusal(importOpenApi(input(document)));
    expect(error.code).toBe("expansion_limit");
    expect(error.limit).toBe(3000);
    expect(error.message).toMatch(/^The parsed document passed 3,000 nodes, the limit for one import\. /);
  });

  it("refuses schemas that expand to more nodes than the limit across tools", async () => {
    // Big expands to 82 nodes, under the 60-node soft limit when each tool starts.
    // Twenty tools that return it pass 1,500 nodes, while the parsed document stays near 400.
    const paths = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `/r${i}`,
        { get: { operationId: `getR${i}`, responses: json({ $ref: "#/components/schemas/Big" }) } },
      ]),
    );
    const document = {
      openapi: "3.1.0",
      info: { title: "Big", version: "1" },
      paths,
      components: { schemas: { Big: { type: "object", properties: strings(40) } } },
    };
    const error = await refusal(importOpenApi(input(document)));
    expect(error.code).toBe("expansion_limit");
    expect(error.limit).toBe(1500);
    expect(error.message).toMatch(/^Schema expansion passed 1,500 nodes, the limit for one import\. /);
  });

  it("cuts each $ref to a stub once a tool passes the soft limit", async () => {
    const schema = {
      type: "object",
      properties: { ...strings(40), zz: { $ref: "#/components/schemas/Leaf" } },
    };
    const document = {
      openapi: "3.1.0",
      info: { title: "Wide", version: "1" },
      paths: { "/wide": { get: { operationId: "getWide", responses: json(schema) } } },
      components: { schemas: { Leaf: { type: "integer" } } },
    };
    const result = await importOpenApi(input(document));
    expect(result.notes).toContainEqual({
      tool: "get_wide",
      message: "This tool's schemas passed 60 nodes, so import cut each $ref after that point to a stub.",
    });
    const tool = result.tools.find((item) => item.name === "get_wide")!;
    const properties = tool.outputSchema!.properties as JsonRecord;
    expect(properties.p39).toEqual({ type: "string" });
    expect(properties.zz).toEqual({ type: "integer", description: "Cut: this tool's schemas passed 60 nodes." });
  });
});
