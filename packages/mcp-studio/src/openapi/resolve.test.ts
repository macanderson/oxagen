// resolve.test.ts: keywords beside a schema's $ref hold in addition to the
// target, so neither replaces the other's constraints.
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { importOpenApi } from ".";
import type { JsonRecord } from "./json";

/** The output schema of GET /pets, whose 200 response returns `schema`, beside these components.schemas. */
async function outputOf(schema: unknown, schemas: JsonRecord): Promise<JsonRecord | undefined> {
  const document = {
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    paths: {
      "/pets": {
        get: { operationId: "getPet", responses: { "200": { description: "OK", content: { "application/json": { schema } } } } },
      },
    },
    components: { schemas },
  };
  const result = await importOpenApi({
    files: [{ path: "openapi.yaml", text: stringify(document) }],
    entry: "openapi.yaml",
    overlay: undefined,
  });
  return result.tools[0]?.outputSchema;
}

const PET = {
  type: "object",
  description: "A pet.",
  properties: { id: { type: "string" }, name: { type: "string" } },
  required: ["id"],
};

describe("keywords beside a schema's $ref", () => {
  it("join the target's required list instead of replacing it", async () => {
    const output = await outputOf({ $ref: "#/components/schemas/Pet", required: ["name"] }, { Pet: PET });
    expect(output).toStrictEqual({ ...PET, required: ["id", "name"] });
  });

  it("merge their properties with the target's, as an allOf where both name one", async () => {
    const output = await outputOf(
      { $ref: "#/components/schemas/Pet", properties: { name: { minLength: 1 }, tag: { type: "string" } } },
      { Pet: PET },
    );
    expect(output?.properties).toStrictEqual({
      id: { type: "string" },
      name: { allOf: [{ type: "string" }, { minLength: 1 }] },
      tag: { type: "string" },
    });
    expect(output?.required).toStrictEqual(["id"]);
  });

  it("replace the target's description, which describes this use of it", async () => {
    const output = await outputOf({ $ref: "#/components/schemas/Pet", description: "The pet asked for." }, { Pet: PET });
    expect(output).toStrictEqual({ ...PET, description: "The pet asked for." });
  });

  it("keep both constraints as an allOf when they disagree", async () => {
    const name = { type: "string", maxLength: 10 };
    const output = await outputOf(
      {
        type: "object",
        properties: { name: { $ref: "#/components/schemas/Name", maxLength: 5, description: "Short." } },
      },
      { Name: name },
    );
    expect(output?.properties).toStrictEqual({
      name: { description: "Short.", allOf: [name, { maxLength: 5 }] },
    });
  });

  it("keep an allOf when the target refuses the properties the $ref adds", async () => {
    const closed = { type: "object", properties: { id: { type: "string" } }, additionalProperties: false };
    const output = await outputOf(
      { $ref: "#/components/schemas/Closed", properties: { extra: { type: "string" } } },
      { Closed: closed },
    );
    expect(output).toStrictEqual({ type: "object", allOf: [closed, { properties: { extra: { type: "string" } } }] });
  });

  it("hold at every hop of a $ref chain, and the outermost description wins", async () => {
    const output = await outputOf(
      { $ref: "#/components/schemas/Named", required: ["tag"], description: "Outer." },
      {
        Named: { $ref: "#/components/schemas/Pet", required: ["name"], description: "Inner." },
        Pet: { ...PET, properties: { ...PET.properties, tag: { type: "string" } } },
      },
    );
    expect(output?.required).toStrictEqual(["id", "name", "tag"]);
    expect(output?.description).toBe("Outer.");
  });
});
