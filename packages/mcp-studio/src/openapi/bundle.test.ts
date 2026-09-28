// bundle.test.ts: which copy a later $ref to another file's value points at.
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { importOpenApi } from ".";
import { ParsedFiles, bundle } from "./bundle";
import type { JsonRecord } from "./json";

/** The entry's `components.schemas` after the bundle. The entry is openapi.yaml. */
function bundledSchemas(schemas: JsonRecord, other: JsonRecord): JsonRecord {
  const entry = { openapi: "3.1.0", info: { title: "x", version: "1" }, paths: {}, components: { schemas } };
  const files = new ParsedFiles(
    new Map([
      ["openapi.yaml", stringify(entry)],
      ["other.yaml", stringify(other)],
    ]),
  );
  const document = bundle(files, "openapi.yaml").document as JsonRecord;
  return (document.components as JsonRecord).schemas as JsonRecord;
}

describe("bundle", () => {
  it("does not reuse a copy made at a $ref with other keys", () => {
    const schemas = bundledSchemas(
      { First: { $ref: "other.yaml#/Name", maxLength: 5 }, Second: { $ref: "other.yaml#/Name" } },
      { Name: { type: "string" } },
    );
    expect(schemas.First).toStrictEqual({ type: "string", maxLength: 5 });
    expect(schemas.Second).toStrictEqual({ type: "string" });
  });

  it("points a $ref with other keys at an earlier bare copy and keeps its keys", () => {
    const schemas = bundledSchemas(
      { First: { $ref: "other.yaml#/Name" }, Second: { $ref: "other.yaml#/Name", maxLength: 5 } },
      { Name: { type: "string" } },
    );
    expect(schemas.First).toStrictEqual({ type: "string" });
    expect(schemas.Second).toStrictEqual({ $ref: "#/components/schemas/First", maxLength: 5 });
  });

  it("ends a cycle inside a copy with other keys at a bare copy", () => {
    const schemas = bundledSchemas(
      { Head: { $ref: "other.yaml#/Node", description: "head" }, Tail: { $ref: "other.yaml#/Node" } },
      { Node: { type: "object", properties: { next: { $ref: "#/Node" } } } },
    );
    const inner = "#/components/schemas/Head/properties/next";
    expect(schemas.Head).toStrictEqual({
      type: "object",
      properties: { next: { type: "object", properties: { next: { $ref: inner } } } },
      description: "head",
    });
    expect(schemas.Tail).toStrictEqual({ $ref: inner });
  });

  it("ends a cycle of $refs that all carry other keys", () => {
    const schemas = bundledSchemas(
      { Head: { $ref: "other.yaml#/Node", description: "head" } },
      { Node: { type: "object", properties: { next: { $ref: "#/Node", description: "next" } } } },
    );
    expect(schemas.Head).toStrictEqual({
      type: "object",
      properties: { next: { $ref: "#/components/schemas/Head", description: "next" } },
      description: "head",
    });
  });
});

describe("a value from another file referenced twice", () => {
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
});
