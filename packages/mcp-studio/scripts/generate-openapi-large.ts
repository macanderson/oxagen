// generate-openapi-large.ts: writes fixtures/openapi/large.yaml, an OpenAPI
// 3.0 document with 600 operations.
//
//   tsx packages/mcp-studio/scripts/generate-openapi-large.ts
//
// Five areas of twenty resources give 100 resources. Each resource has six
// operations: list, create, get, replace, update, and delete. The output
// depends on nothing but this file, so a rerun writes the same bytes.
//
// The document exists to be large. Its definitions run far past the server
// definition budget, so an import must offer exposure search, and the
// importer must finish a document this size in reasonable time.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const AREAS = ["billing", "catalog", "crm", "people", "ops"] as const;

const NOUNS = [
  "account",
  "address",
  "alert",
  "approval",
  "asset",
  "batch",
  "budget",
  "contact",
  "contract",
  "device",
  "document",
  "event",
  "invoice",
  "location",
  "note",
  "policy",
  "project",
  "report",
  "schedule",
  "ticket",
] as const;

type Json = Record<string, unknown>;

/** billing + invoice → BillingInvoice. */
function pascal(...words: string[]): string {
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

function jsonBody(schema: Json): Json {
  return { content: { "application/json": { schema } } };
}

function ref(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
}

/** The six operations for one resource, keyed by path then method. */
function resourcePaths(area: string, noun: string): Record<string, Json> {
  const type = pascal(area, noun);
  const plural = /(s|ch)$/.test(noun) ? `${noun}es` : `${noun}s`;
  const collection = `/${area}/${plural}`;
  const item = `${collection}/{${noun}_id}`;
  const itemId = {
    name: `${noun}_id`,
    in: "path",
    required: true,
    schema: { type: "string" },
  };
  return {
    [collection]: {
      get: {
        operationId: `list${pascal(area, plural)}`,
        summary: `List ${area} ${plural}, newest first.`,
        tags: [area],
        parameters: [{ $ref: "#/components/parameters/Cursor" }, { $ref: "#/components/parameters/Limit" }],
        responses: {
          "200": {
            description: `One page of ${plural}.`,
            ...jsonBody({
              type: "object",
              properties: {
                data: { type: "array", items: ref(type) },
                next_cursor: { type: "string" },
              },
            }),
          },
        },
      },
      post: {
        operationId: `create${type}`,
        summary: `Create a ${area} ${noun}.`,
        tags: [area],
        requestBody: { required: true, ...jsonBody(ref(`New${type}`)) },
        responses: { "201": { description: `The ${noun}.`, ...jsonBody(ref(type)) } },
      },
    },
    [item]: {
      parameters: [itemId],
      get: {
        operationId: `get${type}`,
        summary: `Read one ${area} ${noun}.`,
        tags: [area],
        responses: {
          "200": { description: `The ${noun}.`, ...jsonBody(ref(type)) },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        operationId: `replace${type}`,
        summary: `Replace a ${area} ${noun}.`,
        tags: [area],
        requestBody: { required: true, ...jsonBody(ref(`New${type}`)) },
        responses: { "200": { description: `The ${noun}.`, ...jsonBody(ref(type)) } },
      },
      patch: {
        operationId: `update${type}`,
        summary: `Change some fields of a ${area} ${noun}.`,
        tags: [area],
        requestBody: { required: true, ...jsonBody(ref(`New${type}`)) },
        responses: { "200": { description: `The ${noun}.`, ...jsonBody(ref(type)) } },
      },
      delete: {
        operationId: `delete${type}`,
        summary: `Delete a ${area} ${noun}.`,
        tags: [area],
        responses: { "204": { description: `The ${noun} is gone.` } },
      },
    },
  };
}

/** The two schemas for one resource: what a caller sends, and what comes back. */
function resourceSchemas(area: string, noun: string): Record<string, Json> {
  const type = pascal(area, noun);
  return {
    [`New${type}`]: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", maxLength: 120 },
        description: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["active", "archived"] },
      },
    },
    [type]: {
      allOf: [
        ref(`New${type}`),
        {
          type: "object",
          required: ["id", "created_at"],
          properties: {
            id: { type: "string" },
            created_at: { type: "string", format: "date-time" },
          },
        },
      ],
    },
  };
}

function largeDocument(): Json {
  const paths: Record<string, Json> = {};
  const schemas: Record<string, Json> = {};
  for (const area of AREAS) {
    for (const noun of NOUNS) {
      Object.assign(paths, resourcePaths(area, noun));
      Object.assign(schemas, resourceSchemas(area, noun));
    }
  }
  return {
    openapi: "3.0.3",
    info: { title: "a-intel back office", version: "7.0.0" },
    servers: [{ url: "https://backoffice.a-intel.com/v7" }],
    security: [{ bearer: [] }],
    paths,
    components: {
      parameters: {
        Cursor: {
          name: "cursor",
          in: "query",
          description: "The next_cursor from the previous page.",
          schema: { type: "string" },
        },
        Limit: {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
      },
      responses: {
        NotFound: {
          description: "No record has that id.",
          content: {
            "application/problem+json": {
              schema: {
                type: "object",
                properties: { title: { type: "string" }, detail: { type: "string" } },
              },
            },
          },
        },
      },
      schemas,
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
  };
}

const HEADER = [
  "# Generated by scripts/generate-openapi-large.ts. Do not edit by hand.",
  "# 5 areas x 20 resources x 6 operations = 600 operations.",
  "",
].join("\n");

const out = fileURLToPath(new URL("../fixtures/openapi/large.yaml", import.meta.url));
writeFileSync(out, HEADER + stringify(largeDocument(), { aliasDuplicateObjects: false, lineWidth: 0 }));
console.log(`wrote ${out}`);
