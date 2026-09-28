// import.test.ts: every refusal import can make, and the overlay, through importOpenApi.
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentHash } from "../contract/hashes";
import { importOpenApi, type OpenApiInput } from ".";
import { OpenApiImportError } from "./errors";
import type { JsonRecord } from "./json";
import { DEFINITION_BYTES_MAX, DEPTH_MAX } from "./limits";
import { utf8Length } from "./load";

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

/** One file as import input. A .json path is written as JSON, and anything else as YAML. */
function single(document: unknown, path = "openapi.yaml", overlay?: string): OpenApiInput {
  const text = path.endsWith(".json") ? JSON.stringify(document) : stringify(document);
  return { files: [{ path, text }], entry: path, overlay };
}

/** Several files as import input, each written as YAML. The entry is openapi.yaml. */
function folder(files: Record<string, unknown>): OpenApiInput {
  return {
    files: Object.entries(files).map(([path, document]) => ({ path, text: stringify(document) })),
    entry: "openapi.yaml",
    overlay: undefined,
  };
}

function json(schema: unknown): JsonRecord {
  return { "200": { description: "OK", content: { "application/json": { schema } } } };
}

/** An OpenAPI 3.1 document whose one operation returns `schema`. */
function returning(schema: unknown, extra: JsonRecord = {}): JsonRecord {
  return {
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    paths: { "/pets": { get: { operationId: "listPets", responses: json(schema) } } },
    ...extra,
  };
}

/** `leaf` nested `levels` deep under keys named "a". */
function nested(levels: number, leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < levels; i += 1) value = { a: value };
  return value;
}

describe("the size limit", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Length("a")).toBe(1);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    expect(utf8Length("\ud800")).toBe(3);
    expect(utf8Length("\ud800x")).toBe(4);
  });

  it("refuses files that pass the limit together, naming the size and the limit", async () => {
    const input: OpenApiInput = {
      files: [
        { path: "openapi.yaml", text: "x".repeat(DEFINITION_BYTES_MAX) },
        { path: "schemas/pet.yaml", text: "y" },
      ],
      entry: "openapi.yaml",
      overlay: undefined,
    };
    const error = await refusal(importOpenApi(input));
    expect(error.code).toBe("too_large");
    expect(error.limit).toBe(DEFINITION_BYTES_MAX);
    expect(error.message).toMatch(/^The document is 26,214,401 bytes, over the 26,214,400-byte \(25 MB\) limit\. /);
  });

  it("measures the limit in bytes", async () => {
    const text = "é".repeat(DEFINITION_BYTES_MAX / 2 + 1);
    const error = await refusal(importOpenApi({ files: [{ path: "openapi.yaml", text }], entry: "openapi.yaml", overlay: undefined }));
    expect(error.code).toBe("too_large");
    expect(error.message).toMatch(/^The document is 26,214,402 bytes/);
  });

  it("refuses an overlay over the limit", async () => {
    const input = single(returning({ type: "object" }), "openapi.yaml", "x".repeat(DEFINITION_BYTES_MAX + 1));
    const error = await refusal(importOpenApi(input));
    expect(error.code).toBe("too_large");
    expect(error.limit).toBe(DEFINITION_BYTES_MAX);
    expect(error.message).toMatch(/^overlay\.yaml is 26,214,401 bytes/);
  });
});

describe("the parse", () => {
  it("refuses YAML that does not parse, naming the file", async () => {
    const error = await refusal(importOpenApi({ files: [{ path: "openapi.yaml", text: "openapi: [" }], entry: "openapi.yaml", overlay: undefined }));
    expect(error.code).toBe("parse");
    expect(error.message).toMatch(/^openapi\.yaml is not valid YAML: /);
  });

  it("refuses JSON that does not parse, naming the file", async () => {
    const error = await refusal(importOpenApi({ files: [{ path: "openapi.json", text: "{" }], entry: "openapi.json", overlay: undefined }));
    expect(error.code).toBe("parse");
    expect(error.message).toMatch(/^openapi\.json is not valid JSON: /);
  });

  it("reads JSON that opens with a byte order mark", async () => {
    const text = `﻿${JSON.stringify(returning({ type: "object" }))}`;
    const result = await importOpenApi({ files: [{ path: "openapi.json", text }], entry: "openapi.json", overlay: undefined });
    expect(result.tools.map((tool) => tool.name)).toEqual(["list_pets"]);
  });
});

describe("the version", () => {
  it.each([
    ["a mapping with no openapi field", { title: "x" }],
    ["a list", ["a"]],
  ])("refuses %s as not OpenAPI", async (_, document) => {
    const error = await refusal(importOpenApi(single(document)));
    expect(error.code).toBe("not_openapi");
    expect(error.message).toMatch(/^openapi\.yaml has no openapi or swagger field/);
  });

  it.each([
    [{ openapi: "3.2.0" }, "openapi.yaml is OpenAPI 3.2.0."],
    [{ openapi: 4 }, "openapi.yaml is OpenAPI 4.0."],
    [{ swagger: "1.2" }, "openapi.yaml is Swagger 1.2."],
    [{ openapi: true }, "openapi.yaml has an openapi field that is not a version number."],
    [{ swagger: true }, "openapi.yaml has a swagger field that is not a version number."],
  ])("refuses %j and says what it declares", async (fields, opening) => {
    const error = await refusal(importOpenApi(single({ info: { title: "x", version: "1" }, paths: {}, ...fields })));
    expect(error.code).toBe("unsupported_version");
    expect(error.message.startsWith(`${opening} Import reads OpenAPI 3.1 and 3.0, and Swagger 2.0.`)).toBe(true);
  });

  it.each(["3.1", "3.0"])("reads openapi: %s written as a YAML number", async (version) => {
    const text = stringify(returning({ type: "object" })).replace(/^openapi: .*$/m, `openapi: ${version}`);
    const result = await importOpenApi({ files: [{ path: "openapi.yaml", text }], entry: "openapi.yaml", overlay: undefined });
    expect(result.tools.map((tool) => tool.name)).toEqual(["list_pets"]);
  });
});

describe("refs that leave the folder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["../x.yaml", "/abs.yaml"])("refuses the file path %s", async (path) => {
    const input: OpenApiInput = {
      files: [
        { path: "openapi.yaml", text: stringify(returning({ type: "object" })) },
        { path, text: "{}" },
      ],
      entry: "openapi.yaml",
      overlay: undefined,
    };
    const error = await refusal(importOpenApi(input));
    expect(error.code).toBe("ref_outside");
    expect(error.ref).toBe(path);
    expect(error.message).toMatch(/is absolute or climbs out of the server's folder/);
  });

  it.each(["https://example.com/pet.yaml", "file:///etc/passwd"])("refuses the $ref %s and never fetches it", async (ref) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const error = await refusal(importOpenApi(single(returning({ $ref: ref }))));
    expect(error.code).toBe("ref_outside");
    expect(error.ref).toBe(ref);
    expect(error.message).toContain(`The $ref "${ref}" in openapi.yaml points outside the folder.`);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("refs that name nothing", () => {
  it("refuses an entry that is not among the files", async () => {
    const input: OpenApiInput = { files: [{ path: "api.yaml", text: "{}" }], entry: "openapi.yaml", overlay: undefined };
    const error = await refusal(importOpenApi(input));
    expect(error.code).toBe("ref_missing");
    expect(error.ref).toBe("openapi.yaml");
    expect(error.message).toMatch(/^The entry "openapi\.yaml" is not among the files given\./);
  });

  it("refuses a $ref to a file that is not in the folder", async () => {
    const error = await refusal(importOpenApi(single(returning({ $ref: "schemas/missing.yaml" }))));
    expect(error.code).toBe("ref_missing");
    expect(error.ref).toBe("schemas/missing.yaml");
  });

  it("refuses a $ref to a location another file does not have", async () => {
    const input = folder({
      "openapi.yaml": returning({ $ref: "schemas/pet.yaml#/Nope" }),
      "schemas/pet.yaml": { Pet: { type: "object" } },
    });
    const error = await refusal(importOpenApi(input));
    expect(error.code).toBe("ref_missing");
    expect(error.ref).toBe("schemas/pet.yaml#/Nope");
    expect(error.message).toMatch(/names a location schemas\/pet\.yaml does not have/);
  });

  it("refuses a local $ref to a location the document does not have", async () => {
    const error = await refusal(importOpenApi(single(returning({ $ref: "#/components/schemas/Nope" }))));
    expect(error.code).toBe("ref_missing");
    expect(error.ref).toBe("#/components/schemas/Nope");
    expect(error.message).toMatch(/names a location the document does not have/);
  });

  it("refuses a local $ref that uses an anchor", async () => {
    const error = await refusal(importOpenApi(single(returning({ $ref: "#Pet" }))));
    expect(error.code).toBe("ref_missing");
    expect(error.message).toMatch(/uses an anchor/);
  });
});

describe("cycles", () => {
  it("refuses a $ref chain that leads back to itself with no schema between", async () => {
    const document = returning(
      { $ref: "#/components/schemas/A" },
      { components: { schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } } } },
    );
    const error = await refusal(importOpenApi(single(document)));
    expect(error.code).toBe("ref_cycle");
    expect(error.ref).toBe("#/components/schemas/A");
    expect(error.message).toMatch(/leads back to itself through \$ref alone/);
  });

  it("names a Swagger 2.0 cycle across files under definitions", async () => {
    const input = folder({
      "openapi.yaml": {
        swagger: "2.0",
        info: { title: "Nodes", version: "1" },
        produces: ["application/json"],
        paths: {
          "/node": { get: { operationId: "getNode", responses: { "200": { description: "OK", schema: { $ref: "node.yaml" } } } } },
        },
      },
      "node.yaml": { type: "object", properties: { child: { $ref: "node.yaml" } } },
    });
    const result = await importOpenApi(input);
    expect(result.files).toHaveLength(1);
    const bundled = parse(result.files[0]!.text) as JsonRecord;
    expect(Object.keys(bundled.definitions as JsonRecord)).toEqual(["node"]);
    expect(result.files[0]!.text).toContain("#/definitions/node");
    expect(result.tools.map((tool) => tool.name)).toEqual(["get_node"]);
    expect(result.notes).toContainEqual({ tool: "get_node", message: "Import cut the recursive schema node at depth 4." });
  });
});

describe("the depth limit", () => {
  it("refuses a file that nests too deep", async () => {
    const document = { openapi: "3.1.0", info: { title: "x", version: "1", deep: nested(300, 1) }, paths: {} };
    const error = await refusal(importOpenApi(single(document, "openapi.json")));
    expect(error.code).toBe("depth_limit");
    expect(error.limit).toBe(DEPTH_MAX);
    expect(error.message).toMatch(/^openapi\.json nests deeper than 256 levels/);
  });

  it("refuses a bundle that nests too deep though each file does not", async () => {
    const entry = { openapi: "3.1.0", info: { title: "x", version: "1", deep: nested(200, { $ref: "deep.json" }) }, paths: {} };
    const input: OpenApiInput = {
      files: [
        { path: "openapi.json", text: JSON.stringify(entry) },
        { path: "deep.json", text: JSON.stringify(nested(100, 1)) },
      ],
      entry: "openapi.json",
      overlay: undefined,
    };
    const error = await refusal(importOpenApi(input));
    expect(error.code).toBe("depth_limit");
    expect(error.limit).toBe(DEPTH_MAX);
    expect(error.message).toMatch(/^The bundled document nests deeper than 256 levels/);
  });

  it("refuses a schema that expands too deep", async () => {
    const schemas: JsonRecord = {};
    for (let i = 0; i < 300; i += 1) schemas[`S${i}`] = { type: "array", items: { $ref: `#/components/schemas/S${i + 1}` } };
    schemas.S300 = { type: "string" };
    const document = returning({ $ref: "#/components/schemas/S0" }, { components: { schemas } });
    const error = await refusal(importOpenApi(single(document)));
    expect(error.code).toBe("depth_limit");
    expect(error.limit).toBe(DEPTH_MAX);
    expect(error.message).toMatch(/^A schema nests deeper than 256 levels/);
  });
});

describe("the overlay", () => {
  const document: JsonRecord = {
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
          responses: json({ type: "object", properties: { "a'b": { type: "string" }, keep: { type: "string" } } }),
        },
        post: { operationId: "createPet", responses: { "201": { description: "Created" } } },
      },
    },
  };
  const text = stringify(document);
  const withOverlay = (overlay: unknown): OpenApiInput => ({
    files: [{ path: "openapi.yaml", text }],
    entry: "openapi.yaml",
    overlay: stringify(overlay),
  });
  const overlay = (actions: unknown[]): JsonRecord => ({ overlay: "1.0.0", info: { title: "Trim", version: "1" }, actions });

  it("removes and updates what its targets match, and leaves the hash alone", async () => {
    const result = await importOpenApi(
      withOverlay(
        overlay([
          { target: "$.paths['/pets'].post", remove: true },
          {
            target: "$.paths['/pets'].get",
            update: {
              description: "Lists every pet.",
              parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
              responses: { "200": { description: "Every pet." } },
            },
          },
        ]),
      ),
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(["list_pets"]);
    const [tool] = result.tools;
    expect(tool!.description).toBe("Lists every pet.");
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(["limit", "q"]);
    expect(result.document_hash).toBe(documentHash(text));
    expect(result.notes.filter((note) => note.message.startsWith("Overlay"))).toEqual([]);
  });

  it("appends an update to an array it matches", async () => {
    const result = await importOpenApi(
      withOverlay(overlay([{ target: "$.paths['/pets'].get.parameters", update: { name: "q", in: "query", schema: { type: "string" } } }])),
    );
    const tool = result.tools.find((item) => item.name === "list_pets")!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["limit", "q"]);
  });

  it("removes a key that holds a quote", async () => {
    const target = `$.paths['/pets'].get.responses['200'].content['application/json'].schema.properties["a'b"]`;
    const result = await importOpenApi(withOverlay(overlay([{ target, remove: true }])));
    const tool = result.tools.find((item) => item.name === "list_pets")!;
    expect(Object.keys(tool.outputSchema!.properties as JsonRecord)).toEqual(["keep"]);
  });

  it("notes an action that matches nothing, has nothing to do, or cannot apply", async () => {
    const result = await importOpenApi(
      withOverlay(
        overlay([
          { target: "$.paths['/nope']", remove: true },
          { target: "$.info" },
          { target: "$.info.title", update: { text: "x" } },
        ]),
      ),
    );
    expect(result.notes.filter((note) => note.message.startsWith("Overlay"))).toEqual([
      { tool: undefined, message: "Overlay action 1 matched nothing: $.paths['/nope']." },
      { tool: undefined, message: "Overlay action 2 has no update and no remove, so import skipped it." },
      {
        tool: undefined,
        message: "Overlay action 3 cannot update $['info']['title']: an update merges into an object or appends to an array.",
      },
    ]);
  });

  it.each([
    [["a"], "it is not a mapping"],
    [{ overlay: "2.0.0", actions: [] }, "its overlay field is not 1.0.0"],
    [{ overlay: "1.0.0" }, "it has no actions list"],
    [overlay(["x"]), "action 1 is not a mapping"],
    [overlay([{ remove: true }]), "action 1 has no target"],
    [overlay([{ target: "$.info", remove: "yes" }]), "action 1 has a remove that is not true or false"],
  ])("refuses the overlay %j", async (value, why) => {
    const error = await refusal(importOpenApi(withOverlay(value)));
    expect(error.code).toBe("overlay");
    expect(error.message).toBe(`overlay.yaml is not a valid Overlay 1.0 document: ${why}. Fix it and import again.`);
  });

  it("refuses a target that is not JSONPath", async () => {
    const error = await refusal(importOpenApi(withOverlay(overlay([{ target: "$[", remove: true }]))));
    expect(error.code).toBe("overlay");
    expect(error.message).toMatch(/^Action 1 in overlay\.yaml has a target that is not valid JSONPath \(\$\[\): /);
  });

  it("refuses an action that removes the whole document", async () => {
    const error = await refusal(importOpenApi(withOverlay(overlay([{ target: "$", remove: true }]))));
    expect(error.code).toBe("overlay");
    expect(error.message).toMatch(/^Action 1 in overlay\.yaml removes the whole document\./);
  });

  it("refuses an overlay that does not parse", async () => {
    const input: OpenApiInput = { files: [{ path: "openapi.yaml", text }], entry: "openapi.yaml", overlay: "actions: [" };
    const error = await refusal(importOpenApi(input));
    expect(error.code).toBe("parse");
    expect(error.message).toMatch(/^overlay\.yaml is not valid YAML: /);
  });
});
