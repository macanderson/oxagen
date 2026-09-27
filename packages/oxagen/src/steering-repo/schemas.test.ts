import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agentSchema } from "./agent";
import { bundleSchema } from "./bundle";
import { readFixtureTree } from "./fixture-repo";
import {
  JSON_SCHEMA_DIALECT,
  renderSchemaFile,
  SCHEMAS_DIR,
  schemaFilePath,
  writeSchemaFiles,
} from "./generate-schemas";
import { governanceSchema } from "./governance";
import { memorySchema } from "./memory";
import { promotionSchema } from "./promotion";
import { steeringRecordSchema } from "./record";
import { reflectionSchema } from "./reflection";
import {
  SCHEMA_BASE_URL,
  SCHEMA_IDS,
  schemaUrl,
  STEERING_REPO_SCHEMA_IDS,
  type SteeringRepoSchemaId,
} from "./schema-ids";
import { schemaFor, STEERING_REPO_SCHEMAS } from "./schemas";
import { toolbeltSchema } from "./toolbelt";
import { workspaceSchema } from "./workspace";

// The schema each module exports for its id. The Record type makes a new id
// fail to compile here until it has an entry.
const MODULE_SCHEMAS: Record<SteeringRepoSchemaId, z.ZodTypeAny> = {
  "steering-record/v1": steeringRecordSchema,
  "workspace/v1": workspaceSchema,
  "agent/v1": agentSchema,
  "governance/v1": governanceSchema,
  "toolbelt/v1": toolbeltSchema,
  "reflection/v1": reflectionSchema,
  "memory/v1": memorySchema,
  "promotion/v1": promotionSchema,
  "bundle/v1": bundleSchema,
};

// Contract ids that name a schema this module does not publish.
const OTHER_IDS = SCHEMA_IDS.filter(
  (id) => !(STEERING_REPO_SCHEMA_IDS as readonly string[]).includes(id),
);

describe("STEERING_REPO_SCHEMAS", () => {
  it("has one entry per steering repo schema id, in the same order", () => {
    expect(STEERING_REPO_SCHEMAS.map((entry) => entry.id)).toEqual([
      ...STEERING_REPO_SCHEMA_IDS,
    ]);
  });

  it.each(STEERING_REPO_SCHEMAS)("gives $id a title, a description ending in a full stop, and its module's schema", (entry) => {
    expect(entry.title).not.toBe("");
    expect(entry.description).toMatch(/^\S.*\.$/);
    expect(entry.schema).toBe(MODULE_SCHEMAS[entry.id]);
  });

  it("gives every schema its own title", () => {
    const titles = STEERING_REPO_SCHEMAS.map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("schemaFor", () => {
  it.each(STEERING_REPO_SCHEMA_IDS)("returns the schema its module exports for %s", (id) => {
    expect(schemaFor(id)).toBe(MODULE_SCHEMAS[id]);
  });

  it.each([...OTHER_IDS, "nothing/v1"])("throws a TypeError for %s, which it has no schema for", (id) => {
    expect(() => schemaFor(id as unknown as SteeringRepoSchemaId)).toThrow(TypeError);
  });

  it("has other contract ids to refuse", () => {
    expect(OTHER_IDS.length).toBeGreaterThan(0);
  });
});

describe("the published schema files", () => {
  const committed = readFixtureTree(SCHEMAS_DIR);

  it("uses JSON Schema draft 2020-12", () => {
    expect(JSON_SCHEMA_DIALECT).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("commits one file per schema and nothing else", () => {
    expect([...committed.keys()].sort()).toEqual(
      STEERING_REPO_SCHEMAS.map((entry) => schemaFilePath(entry)).sort(),
    );
  });

  it.each(STEERING_REPO_SCHEMAS)("places $id at <id>.json", (entry) => {
    expect(schemaFilePath(entry)).toBe(`${entry.id}.json`);
  });

  it.each(STEERING_REPO_SCHEMAS)(
    "commits $id exactly as its zod schema renders. Run generate-schemas.ts if this fails",
    (entry) => {
      expect(committed.get(schemaFilePath(entry))).toBe(renderSchemaFile(entry));
    },
  );

  // The steering record spec's canonical frontmatter schema, for the fields
  // the memory provenance change added.
  it("publishes toolbelt and provenance as the canonical steering-record/v1 writes them", () => {
    const entry = STEERING_REPO_SCHEMAS.find(({ id }) => id === "steering-record/v1");
    if (entry === undefined) throw new Error("STEERING_REPO_SCHEMAS has no steering-record/v1");
    const { properties } = JSON.parse(renderSchemaFile(entry)) as {
      properties: Record<string, unknown>;
    };
    expect(properties.toolbelt).toMatchObject({ type: "string", minLength: 1 });
    expect(properties.provenance).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["source", "uri"],
      properties: {
        source: { enum: ["proposal", "run", "import"] },
        uri: { type: "string" },
        agent: { type: "string" },
        memories: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["agent", "run", "statement", "evidence"],
            properties: {
              agent: { anyOf: [{ type: "string" }, { type: "null" }] },
              run: { anyOf: [{ type: "string" }, { type: "null" }] },
              statement: { type: "string", minLength: 1 },
              evidence: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      allOf: [
        { if: { properties: { source: { const: "run" } } }, then: { required: ["memories"] } },
      ],
    });
  });

  it.each(STEERING_REPO_SCHEMAS)("opens the $id file with its dialect, URL, title, and description", (entry) => {
    const text = renderSchemaFile(entry);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      $schema: JSON_SCHEMA_DIALECT,
      $id: schemaUrl(entry.id),
      title: entry.title,
      description: entry.description,
    });
    expect(Object.keys(parsed as object).slice(0, 4)).toEqual([
      "$schema",
      "$id",
      "title",
      "description",
    ]);
    expect(schemaUrl(entry.id)).toBe(`${SCHEMA_BASE_URL}${entry.id}.json`);
    expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });
});

describe("writeSchemaFiles", () => {
  it("writes every schema under the folder it is given, the same as the committed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "oxagen-schemas-"));
    try {
      expect(writeSchemaFiles(dir)).toEqual(
        STEERING_REPO_SCHEMAS.map((entry) => join(dir, schemaFilePath(entry))),
      );
      expect(readFixtureTree(dir)).toEqual(readFixtureTree(SCHEMAS_DIR));
      // A second run writes over the first and changes nothing.
      writeSchemaFiles(dir);
      expect(readFixtureTree(dir)).toEqual(readFixtureTree(SCHEMAS_DIR));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
