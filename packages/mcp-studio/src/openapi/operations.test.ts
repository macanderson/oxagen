// operations.test.ts: how import maps an operation's parameters onto a tool's input.
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { importOpenApi, type OpenApiInput } from ".";
import type { JsonRecord } from "./json";

/** An OpenAPI 3.1 document whose one operation, GET /pets, takes `parameters`. */
function listing(parameters: JsonRecord[]): OpenApiInput {
  const document = {
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    paths: { "/pets": { get: { operationId: "listPets", parameters, responses: { "204": { description: "None" } } } } },
  };
  return { files: [{ path: "openapi.yaml", text: stringify(document) }], entry: "openapi.yaml", overlay: undefined };
}

describe("a parameter with content instead of schema", () => {
  const filter = {
    name: "filter",
    in: "query",
    content: { "application/json": { schema: { type: "object", properties: { color: { type: "string" } } } } },
  };

  it("is skipped with a note, because the gateway would send its fields as separate query parameters", async () => {
    const result = await importOpenApi(listing([{ name: "limit", in: "query", schema: { type: "integer" } }, filter]));
    const [tool] = result.tools;
    expect(tool?.inputSchema.properties).toEqual({ limit: { type: "integer" } });
    expect(tool?.request).toMatchObject({ parameters: [{ name: "limit", in: "query", property: "limit", required: false }] });
    expect(result.notes).toContainEqual({
      tool: "list_pets",
      message: "Import skipped the query parameter filter, because the gateway cannot send a parameter as application/json.",
    });
  });

  it("says a call fails when the API requires it", async () => {
    const result = await importOpenApi(listing([{ ...filter, required: true }]));
    expect(result.tools[0]?.inputSchema.required).toBeUndefined();
    expect(result.notes).toContainEqual({
      tool: "list_pets",
      message:
        "Import skipped the query parameter filter, because the gateway cannot send a parameter as application/json. The API requires it, so a call to this tool fails.",
    });
  });
});

describe("parameters that share a name", () => {
  it("give each parameter an input property no other parameter holds", async () => {
    const result = await importOpenApi(
      listing([
        { name: "id", in: "query", schema: { type: "string" } },
        { name: "id_header", in: "query", schema: { type: "integer" } },
        { name: "id", in: "header", schema: { type: "boolean" } },
      ]),
    );
    const [tool] = result.tools;
    expect(tool?.inputSchema.properties).toEqual({
      id: { type: "string" },
      id_header: { type: "integer" },
      id_header_2: { type: "boolean" },
    });
    const parameters = tool?.request.kind === "http" ? tool.request.parameters : [];
    expect(parameters.map(({ name, in: where, property }) => ({ name, in: where, property }))).toEqual([
      { name: "id", in: "query", property: "id" },
      { name: "id_header", in: "query", property: "id_header" },
      { name: "id", in: "header", property: "id_header_2" },
    ]);
    expect(result.notes).toContainEqual({
      tool: "list_pets",
      message: "Two parameters are named id, so the header parameter's input is id_header_2.",
    });
  });
});
