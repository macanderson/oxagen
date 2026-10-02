// bundle.test.ts: where a value from another file is copied, and what every
// $ref to it points at.
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { importOpenApi } from ".";
import { ParsedFiles, bundle } from "./bundle";
import type { JsonRecord } from "./json";

const BUNDLED = "#/components/x-oxagen-bundled";

/** The entry's `components` after the bundle. The entry is openapi.yaml, and the other files are named by path. */
function bundledComponents(components: JsonRecord, others: Record<string, unknown>): JsonRecord {
  const entry = { openapi: "3.1.0", info: { title: "x", version: "1" }, paths: {}, components };
  const files = new ParsedFiles(
    new Map([["openapi.yaml", stringify(entry)], ...Object.entries(others).map(([path, value]): [string, string] => [path, stringify(value)])]),
  );
  const document = bundle(files, "openapi.yaml").document as JsonRecord;
  return document.components as JsonRecord;
}

describe("bundle", () => {
  it("copies a value once and points every $ref at the copy, keeping each $ref's own keys", () => {
    const components = bundledComponents(
      { schemas: { First: { $ref: "other.yaml#/Name", maxLength: 5 }, Second: { $ref: "other.yaml#/Name" } } },
      { "other.yaml": { Name: { type: "string" } } },
    );
    expect(components.schemas).toStrictEqual({
      First: { $ref: `${BUNDLED}/Name`, maxLength: 5 },
      Second: { $ref: `${BUNDLED}/Name` },
    });
    expect(components["x-oxagen-bundled"]).toStrictEqual({ Name: { type: "string" } });
  });

  it("ends a cycle across files at the copy", () => {
    const components = bundledComponents(
      { schemas: { Head: { $ref: "other.yaml#/Node", description: "head" }, Tail: { $ref: "other.yaml#/Node" } } },
      { "other.yaml": { Node: { type: "object", properties: { next: { $ref: "#/Node", description: "next" } } } } },
    );
    expect(components.schemas).toStrictEqual({
      Head: { $ref: `${BUNDLED}/Node`, description: "head" },
      Tail: { $ref: `${BUNDLED}/Node` },
    });
    expect(components["x-oxagen-bundled"]).toStrictEqual({
      Node: { type: "object", properties: { next: { $ref: `${BUNDLED}/Node`, description: "next" } } },
    });
  });

  it("names a whole file by its path, and never takes a name the entry already holds there", () => {
    const components = bundledComponents(
      {
        schemas: { Pet: { $ref: "schemas/pet.yaml" }, Tag: { $ref: "other.yaml#/Name" } },
        "x-oxagen-bundled": { Name: { type: "integer" } },
      },
      { "schemas/pet.yaml": { type: "object" }, "other.yaml": { Name: { type: "string" } } },
    );
    expect(components.schemas).toStrictEqual({
      Pet: { $ref: `${BUNDLED}/schemas_pet` },
      Tag: { $ref: `${BUNDLED}/Name_2` },
    });
    expect(components["x-oxagen-bundled"]).toStrictEqual({
      Name: { type: "integer" },
      schemas_pet: { type: "object" },
      Name_2: { type: "string" },
    });
  });
});

describe("a value from another file referenced twice", () => {
  /** Two operations, GET /a and GET /b, whose 200 responses both name other.yaml#/Pet. */
  function twoSites(overlay?: unknown) {
    const response = { "200": { description: "OK", content: { "application/json": { schema: { $ref: "other.yaml#/Pet" } } } } };
    const entry = {
      openapi: "3.1.0",
      info: { title: "Pets", version: "1" },
      paths: { "/a": { get: { operationId: "getA", responses: response } }, "/b": { get: { operationId: "getB", responses: response } } },
    };
    const pet = { Pet: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
    return importOpenApi({
      files: [
        { path: "openapi.yaml", text: stringify(entry) },
        { path: "other.yaml", text: stringify(pet) },
      ],
      entry: "openapi.yaml",
      overlay: overlay === undefined ? undefined : stringify(overlay),
    });
  }

  const SITE_A = "$.paths['/a'].get.responses['200'].content['application/json'].schema";
  const overlay = (action: JsonRecord): JsonRecord => ({ overlay: "1.0.0", info: { title: "Edit", version: "1" }, actions: [action] });
  const outputs = (tools: { name: string; outputSchema?: unknown }[]): Record<string, unknown> =>
    Object.fromEntries(tools.map((tool) => [tool.name, tool.outputSchema ?? null]));

  it("gives a later bare $ref none of an earlier $ref's other keys", async () => {
    const entry = {
      openapi: "3.1.0",
      info: { title: "Names", version: "1" },
      paths: {
        "/names": {
          get: {
            operationId: "getNames",
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        first: { $ref: "other.yaml#/Name", maxLength: 5 },
                        second: { $ref: "other.yaml#/Name" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = await importOpenApi({
      files: [
        { path: "openapi.yaml", text: stringify(entry) },
        { path: "other.yaml", text: stringify({ Name: { type: "string" } }) },
      ],
      entry: "openapi.yaml",
      overlay: undefined,
    });
    const properties = result.tools[0]!.outputSchema!.properties as JsonRecord;
    expect(properties.first).toStrictEqual({ type: "string", maxLength: 5 });
    expect(properties.second).toStrictEqual({ type: "string" });
  });

  it("keeps the other site as it was when an overlay updates one site", async () => {
    const result = await twoSites(overlay({ target: SITE_A, update: { required: ["name"], description: "Pet A." } }));
    expect(outputs(result.tools)).toStrictEqual({
      get_a: { type: "object", properties: { id: { type: "string" } }, required: ["id", "name"], description: "Pet A." },
      get_b: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
  });

  it("keeps the other site whole when an overlay removes one site", async () => {
    const result = await twoSites(overlay({ target: SITE_A, remove: true }));
    expect(outputs(result.tools)).toStrictEqual({
      get_a: null,
      get_b: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
  });
});
