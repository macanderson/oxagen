// golden.ts: the OpenAPI fixtures as importOpenApi input, and the value each
// golden file pins. scripts/write-openapi-expected.ts writes the goldens with
// these, and openapi.golden.test.ts checks them with the same functions.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalDigest } from "../../contract/json";
import type { ImportedFile, ImportResult } from "../../model/import-result";
import type { OpenApiInput } from "..";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
export const OPENAPI_FIXTURES = `${FIXTURES}openapi/`;
export const OPENAPI_EXPECTED = `${FIXTURES}expected/openapi/`;

/** Every file under a folder, by its path relative to the folder, in name order. */
export function filesUnder(folder: string, prefix = ""): ImportedFile[] {
  const files: ImportedFile[] = [];
  for (const name of readdirSync(`${folder}${prefix}`).sort()) {
    const path = `${prefix}${name}`;
    if (statSync(`${folder}${path}`).isDirectory()) files.push(...filesUnder(folder, `${path}/`));
    else files.push({ path, text: readFileSync(`${folder}${path}`, "utf8") });
  }
  return files;
}

/** Each entry of fixtures/openapi: a YAML file, or a folder whose entry is openapi.yaml. */
export function fixtureNames(): string[] {
  return readdirSync(OPENAPI_FIXTURES).sort();
}

/** The golden's name for a fixture: large.yaml is large. */
export function goldenStem(name: string): string {
  return name.replace(/\.ya?ml$/, "");
}

/** A fixture as importOpenApi input. */
export function fixtureInput(name: string): OpenApiInput {
  const full = `${OPENAPI_FIXTURES}${name}`;
  if (statSync(full).isDirectory()) return { files: filesUnder(`${full}/`), entry: "openapi.yaml", overlay: undefined };
  return { files: [{ path: name, text: readFileSync(full, "utf8") }], entry: name, overlay: undefined };
}

/**
 * What a golden pins. large.yaml's tools run to megabytes, so its golden
 * holds the counts, a digest of the tools, the first tool, and the paging
 * styles. Every other fixture's golden holds the whole result.
 */
export function goldenValue(stem: string, result: ImportResult): unknown {
  if (stem !== "large") return result;
  const paging: Record<string, number> = {};
  for (const tool of result.tools) {
    const style = tool.paging?.style ?? "none";
    paging[style] = (paging[style] ?? 0) + 1;
  }
  return {
    tools: result.tools.length,
    tools_digest: canonicalDigest(result.tools),
    first_tool: result.tools[0],
    paging,
    listed: result.listed,
    notes: result.notes,
    environments: result.environments,
    auth: result.auth,
    document_hash: result.document_hash,
  };
}
