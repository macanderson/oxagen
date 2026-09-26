import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaUrl } from "@oxagen/oxagen/steering-repo/schema-ids";
import {
  MCP_STUDIO_CONTRACT_SCHEMA_IDS,
  MCP_STUDIO_WIRE_SCHEMA_IDS,
  mcpStudioSchemaUrl,
} from "./schema-ids";
import {
  MCP_STUDIO_SCHEMAS,
  renderSchemaFile,
  schemaFilePath,
  SCHEMAS_DIR,
} from "./schemas";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [relative(SCHEMAS_DIR, path)];
  });
}

describe("published schemas", () => {
  it("match the committed files byte for byte", () => {
    for (const entry of MCP_STUDIO_SCHEMAS) {
      const committed = readFileSync(join(SCHEMAS_DIR, schemaFilePath(entry)), "utf8");
      expect(committed, `${entry.id}: run scripts/generate-schemas.ts`).toBe(renderSchemaFile(entry));
    }
  });

  it("leave no stale file in the schemas folder", () => {
    const expected = MCP_STUDIO_SCHEMAS.map(schemaFilePath).sort();
    expect(filesUnder(SCHEMAS_DIR).sort()).toEqual(expected);
  });

  it("carry the ids the Shared contract names", () => {
    for (const entry of MCP_STUDIO_SCHEMAS) {
      const document = JSON.parse(renderSchemaFile(entry)) as { $id: string };
      expect(document.$id).toBe(`https://oxagen.sh/schemas/${entry.id}.json`);
    }
    for (const id of MCP_STUDIO_CONTRACT_SCHEMA_IDS) {
      expect(mcpStudioSchemaUrl(id)).toBe(schemaUrl(id));
    }
    const published = new Set(MCP_STUDIO_SCHEMAS.map((entry) => entry.id));
    for (const id of MCP_STUDIO_WIRE_SCHEMA_IDS) expect(published.has(id)).toBe(true);
  });
});
