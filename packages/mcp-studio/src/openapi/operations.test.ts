// operations.test.ts: how import maps an operation onto a tool: its input, its
// request template, and its output schema.
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { importOpenApi, type OpenApiInput } from ".";
import type { HttpRequest } from "../model/upstream-tool";
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

// ── Findings from #4613 ──────────────────────────────────────────────────────

type ImportResult = Awaited<ReturnType<typeof importOpenApi>>;
type Tool = ImportResult["tools"][number];

/** An OpenAPI 3.1 document with these paths and any other top-level fields. */
function documentWith(paths: JsonRecord, extra: JsonRecord = {}): OpenApiInput {
  const document = { openapi: "3.1.0", info: { title: "Pets", version: "1" }, paths, ...extra };
  return { files: [{ path: "openapi.yaml", text: stringify(document) }], entry: "openapi.yaml", overlay: undefined };
}

/** The import of a document whose one operation is POST /pets. */
async function importOperation(operation: JsonRecord, extra: JsonRecord = {}): Promise<{ tool: Tool | undefined; notes: ImportResult["notes"] }> {
  const result = await importOpenApi(documentWith({ "/pets": { post: operation } }, extra));
  return { tool: result.tools[0], notes: result.notes };
}

function httpRequest(tool: Tool | undefined): HttpRequest {
  if (tool?.request.kind !== "http") throw new Error("expected an HTTP tool");
  return tool.request;
}

const NO_CONTENT = { "204": { description: "No content" } };

function okJson(schema: unknown): JsonRecord {
  return { description: "OK", content: { "application/json": { schema } } };
}

describe("a parameter an API key scheme names (finding 1)", () => {
  it("stays an input, because only server.toml says which scheme a call uses", async () => {
    const { tool } = await importOperation(
      {
        operationId: "createPet",
        parameters: [{ name: "X-Api-Key", in: "header", required: true, schema: { type: "string" } }],
        responses: NO_CONTENT,
      },
      { components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } } },
    );
    expect(tool?.inputSchema).toStrictEqual({
      type: "object",
      properties: { "X-Api-Key": { type: "string" } },
      required: ["X-Api-Key"],
    });
    expect(httpRequest(tool).parameters).toStrictEqual([
      { name: "X-Api-Key", in: "header", property: "X-Api-Key", required: true },
    ]);
  });
});

describe("a request body (findings 2, 7, and 12)", () => {
  const PET = { type: "object", properties: { name: { type: "string" }, tag: { type: "string" } }, required: ["name"] };
  const body = (schema: unknown, required: boolean, media = "application/json"): JsonRecord => ({
    operationId: "createPet",
    requestBody: { required, content: { [media]: { schema } } },
    responses: NO_CONTENT,
  });

  it("keeps an optional body with required members whole, so they stay required once it is sent", async () => {
    const { tool } = await importOperation(body(PET, false));
    expect(tool?.inputSchema).toStrictEqual({ type: "object", properties: { body: PET } });
    expect(httpRequest(tool).body).toStrictEqual({ in: "property", media_type: "application/json", required: false, property: "body" });
  });

  it("spreads a required body, and an optional one with no required members", async () => {
    const required = await importOperation(body(PET, true));
    expect(required.tool?.inputSchema).toStrictEqual({
      type: "object",
      properties: { name: { type: "string" }, tag: { type: "string" } },
      required: ["name"],
    });
    expect(httpRequest(required.tool).body).toStrictEqual({
      in: "spread",
      media_type: "application/json",
      required: true,
      properties: ["name", "tag"],
    });
    const open = { type: "object", properties: { name: { type: "string" } } };
    const optional = await importOperation(body(open, false));
    expect(optional.tool?.inputSchema).toStrictEqual({ type: "object", properties: { name: { type: "string" } } });
    expect(httpRequest(optional.tool).body).toMatchObject({ in: "spread", required: false });
  });

  it.each([
    ["minProperties", { minProperties: 2 }],
    ["maxProperties", { maxProperties: 1 }],
    ["dependentRequired", { dependentRequired: { b: ["a"] } }],
    ["propertyNames", { propertyNames: { maxLength: 8 } }],
  ])("keeps a body with %s whole, because spreading would drop it", async (_, constraint) => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, ...constraint };
    const { tool } = await importOperation(body(schema, true));
    expect(tool?.inputSchema).toStrictEqual({ type: "object", properties: { body: schema }, required: ["body"] });
    expect(httpRequest(tool).body).toStrictEqual({ in: "property", media_type: "application/json", required: true, property: "body" });
  });

  it("still spreads a body that refuses other properties, since the executor sends only the named ones", async () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    const { tool } = await importOperation(body(schema, true));
    expect(httpRequest(tool).body).toStrictEqual({ in: "spread", media_type: "application/json", required: true, properties: ["a"] });
  });

  it("sends text when the body also offers multipart, which the executor cannot send", async () => {
    const { tool, notes } = await importOperation({
      operationId: "createPet",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string" } } } },
          "text/plain": { schema: { type: "string" } },
        },
      },
      responses: NO_CONTENT,
    });
    expect(httpRequest(tool).body).toStrictEqual({ in: "property", media_type: "text/plain", required: true, property: "body" });
    expect(notes.filter((note) => note.message.includes("cannot send"))).toEqual([]);
  });

  it("chooses multipart with a note when the body offers nothing the executor can send", async () => {
    const { tool, notes } = await importOperation(body({ type: "object", properties: { file: { type: "string" } } }, true, "multipart/form-data"));
    expect(httpRequest(tool).body).toMatchObject({ media_type: "multipart/form-data" });
    expect(notes).toContainEqual({
      tool: "create_pet",
      message: "This tool sends multipart/form-data, which the gateway cannot send yet, so a call to this tool fails.",
    });
  });
});

describe("a cookie parameter (finding 6)", () => {
  it("always carries explode, true by default, so the executor sends each item or member as its own cookie", async () => {
    const { tool } = await importOperation({
      operationId: "createPet",
      parameters: [
        { name: "ids", in: "cookie", schema: { type: "array", items: { type: "string" } } },
        { name: "prefs", in: "cookie", explode: false, schema: { type: "object" } },
        { name: "theme", in: "cookie", style: "cookie", schema: { type: "string" } },
      ],
      responses: NO_CONTENT,
    });
    expect(httpRequest(tool).parameters).toStrictEqual([
      { name: "ids", in: "cookie", property: "ids", required: false, explode: true },
      { name: "prefs", in: "cookie", property: "prefs", required: false, explode: false },
      { name: "theme", in: "cookie", property: "theme", required: false, style: "cookie", explode: true },
    ]);
  });
});

describe("allowReserved (finding 10)", () => {
  it("carries allow_reserved on a query parameter, and on no other kind", async () => {
    const { tool } = await importOperation({
      operationId: "createPet",
      parameters: [
        { name: "path", in: "query", allowReserved: true, schema: { type: "string" } },
        { name: "plain", in: "query", allowReserved: false, schema: { type: "string" } },
        { name: "X-Path", in: "header", allowReserved: true, schema: { type: "string" } },
      ],
      responses: NO_CONTENT,
    });
    expect(httpRequest(tool).parameters).toStrictEqual([
      { name: "path", in: "query", property: "path", required: false, allow_reserved: true },
      { name: "plain", in: "query", property: "plain", required: false },
      { name: "X-Path", in: "header", property: "X-Path", required: false },
    ]);
  });
});

describe("the output schema (findings 3, 8, and 9)", () => {
  const PET = { type: "object", properties: { id: { type: "string" } } };
  const NULL_NOTE = "Import left out this tool's output schema, because the 200 response may be null, and a tool's output schema must describe an object.";

  it("is left out, with a note, for an object result that may be null", async () => {
    const schema = { type: ["object", "null"], properties: { id: { type: "string" } } };
    const { tool, notes } = await importOperation({ operationId: "getPet", responses: { "200": okJson(schema) } });
    expect(tool?.outputSchema).toBeUndefined();
    expect(httpRequest(tool).response).toStrictEqual({ status: "200", media_type: "application/json" });
    expect(notes).toContainEqual({ tool: "get_pet", message: NULL_NOTE });
  });

  it("is left out, with a note, for an array result that may be null, which then arrives unwrapped", async () => {
    const schema = { type: ["array", "null"], items: { type: "string" } };
    const { tool, notes } = await importOperation({ operationId: "getPet", responses: { "200": okJson(schema) } });
    expect(tool?.outputSchema).toBeUndefined();
    expect(httpRequest(tool).response).toStrictEqual({ status: "200", media_type: "application/json" });
    expect(notes).toContainEqual({ tool: "get_pet", message: NULL_NOTE });
  });

  it("is advertised when every successful response shares one JSON schema", async () => {
    const { tool } = await importOperation(
      { operationId: "getPet", responses: { "200": okJson(PET), "201": okJson({ $ref: "#/components/schemas/Pet" }) } },
      { components: { schemas: { Pet: PET } } },
    );
    expect(tool?.outputSchema).toStrictEqual(PET);
    expect(httpRequest(tool).response).toStrictEqual({ status: "200", media_type: "application/json" });
  });

  it("is left out, with a note, when a successful response has no content", async () => {
    const { tool, notes } = await importOperation({ operationId: "getPet", responses: { "200": okJson(PET), "204": { description: "None" } } });
    expect(tool?.outputSchema).toBeUndefined();
    expect(httpRequest(tool).response).toStrictEqual({ status: "200", media_type: "application/json" });
    expect(notes).toContainEqual({
      tool: "get_pet",
      message: "Import left out this tool's output schema, because its successful responses (200 and 204) do not share one JSON schema.",
    });
  });

  it("is left out, with no wrap, when a successful array response sits beside an empty one", async () => {
    const list = { type: "array", items: PET };
    const { tool } = await importOperation({ operationId: "getPet", responses: { "200": okJson(list), "204": { description: "None" } } });
    expect(tool?.outputSchema).toBeUndefined();
    expect(httpRequest(tool).response).toStrictEqual({ status: "200", media_type: "application/json" });
  });

  it("is left out, with a note, when the successful responses' schemas differ", async () => {
    const job = { type: "object", properties: { job: { type: "string" } } };
    const { tool, notes } = await importOperation({
      operationId: "getPet",
      responses: { "200": okJson(PET), "202": okJson(job), "2XX": okJson(PET) },
    });
    expect(tool?.outputSchema).toBeUndefined();
    expect(notes).toContainEqual({
      tool: "get_pet",
      message: "Import left out this tool's output schema, because its successful responses (200, 202, and 2XX) do not share one JSON schema.",
    });
  });

  it("takes the object type when every oneOf branch is an object", async () => {
    const schema = { oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { properties: { b: { type: "string" } } }] };
    const { tool } = await importOperation({ operationId: "getPet", responses: { "200": okJson(schema) } });
    expect(tool?.outputSchema).toStrictEqual({ ...schema, type: "object" });
  });

  it.each([
    ["a string branch", { oneOf: [{ type: "object" }, { type: "string" }] }],
    ["an array branch", { anyOf: [{ type: "object" }, { type: "array", items: { type: "string" } }] }],
    ["a null branch", { anyOf: [{ type: "object" }, { type: "null" }] }],
    ["only untyped allOf parts", { allOf: [{ minLength: 1 }, { maxLength: 3 }] }],
  ])("is left out for a composition with %s, which the executor returns unchanged", async (_, schema) => {
    const { tool } = await importOperation({ operationId: "getPet", responses: { "200": okJson(schema) } });
    expect(tool?.outputSchema).toBeUndefined();
  });
});

describe("an operation with its own servers (finding 5)", () => {
  const ROOT = { servers: [{ url: "https://api.example.com/v1" }] };

  it("sends to its first server in every environment, with a note", async () => {
    const { tool, notes } = await importOperation(
      {
        operationId: "uploadPhoto",
        servers: [{ url: "https://uploads.example.com/v1" }, { url: "https://uploads-eu.example.com/v1" }],
        responses: NO_CONTENT,
      },
      ROOT,
    );
    expect(httpRequest(tool).base_url).toBe("https://uploads.example.com/v1");
    expect(notes).toContainEqual({
      tool: "upload_photo",
      message:
        "This tool sends to https://uploads.example.com/v1 in every environment, because the document gives the operation its own server. " +
        "The document lists 2 servers for it, and import took the first.",
    });
  });

  it("takes the path item's servers when the operation has none, and the operation's over the path item's", async () => {
    const result = await importOpenApi(
      documentWith(
        {
          "/pets": {
            servers: [{ url: "https://pets.example.com" }],
            get: { operationId: "listPets", responses: NO_CONTENT },
            post: {
              operationId: "createPet",
              servers: [{ url: "https://{region}.example.com", variables: { region: { default: "eu" } } }],
              responses: NO_CONTENT,
            },
          },
        },
        ROOT,
      ),
    );
    const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, httpRequest(tool).base_url]));
    expect(byName).toStrictEqual({ list_pets: "https://pets.example.com", create_pet: "https://eu.example.com" });
  });

  it("keeps the environment's url when the list names the document's servers again", async () => {
    const { tool, notes } = await importOperation(
      { operationId: "createPet", servers: [{ url: "https://api.example.com/v1/" }], responses: NO_CONTENT },
      ROOT,
    );
    expect(httpRequest(tool).base_url).toBeUndefined();
    expect(notes.filter((note) => note.message.includes("every environment"))).toEqual([]);
  });

  it.each([
    [
      "/uploads",
      "It is not an absolute http or https URL, and import does not know where the document is served.",
    ],
    ["https://uploads.example.com/v1?x=1", "An API's base url has no query: https://uploads.example.com/v1?x=1."],
  ])("skips the operation when a call cannot use its server %s, so it never runs against the environment", async (url, why) => {
    const result = await importOpenApi(
      documentWith({ "/pets": { post: { operationId: "createPet", servers: [{ url }], responses: NO_CONTENT } } }, ROOT),
    );
    expect(result.tools).toEqual([]);
    expect(result.notes).toContainEqual({
      tool: "create_pet",
      message: `Import skipped POST /pets, because its own server "${url}" cannot be a tool call's base url. ${why}`,
    });
  });
});
