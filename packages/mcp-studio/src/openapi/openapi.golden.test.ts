// openapi.golden.test.ts: each OpenAPI fixture imports to its golden, and
// billing's openapi.yaml imports to expected/billing/upstream.json.
//
// scripts/write-openapi-expected.ts writes the goldens. A golden changes only
// when the importer's output is meant to change, so a diff here is either a
// regression or a golden to rewrite and review.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentHash } from "../contract/hashes";
import { formatJson } from "../contract/json";
import { importOpenApi } from ".";
import { FIXTURES, OPENAPI_EXPECTED, fixtureInput, fixtureNames, goldenStem, goldenValue } from "./__tests__/golden";

/** A value as JSON would carry it, so an undefined field and a missing one compare equal. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("the OpenAPI fixtures", () => {
  it("has every fixture the goldens were written from", () => {
    expect(fixtureNames()).toEqual([
      "large.yaml",
      "multi-file",
      "openapi-3.0.yaml",
      "openapi-3.1.yaml",
      "recursive.yaml",
      "swagger-2.0.yaml",
    ]);
  });

  it.each(fixtureNames())("%s imports to its golden", async (name) => {
    const stem = goldenStem(name);
    const result = await importOpenApi(fixtureInput(name));
    const golden = readFileSync(`${OPENAPI_EXPECTED}${stem}.json`, "utf8");
    expect(formatJson(goldenValue(stem, result))).toBe(golden);
  }, 60_000);

  it("hashes a single file as committed and returns no files", async () => {
    const input = fixtureInput("openapi-3.1.yaml");
    const result = await importOpenApi(input);
    expect(result.files).toEqual([]);
    expect(result.document_hash).toBe(documentHash(input.files[0]!.text));
    expect(result.descriptor_set).toBeUndefined();
  });

  it("bundles a multi-file document into one file and hashes the bundle", async () => {
    const result = await importOpenApi(fixtureInput("multi-file"));
    expect(result.files).toHaveLength(1);
    const bundled = result.files[0]!;
    expect(bundled.path).toBe("openapi.yaml");
    expect(result.document_hash).toBe(documentHash(bundled.text));
    expect(bundled.text).not.toMatch(/\$ref: \.{0,2}\/?(?:paths|schemas)\//);
  });

  it("lists the 3.1 webhook and never makes it a tool", async () => {
    const result = await importOpenApi(fixtureInput("openapi-3.1.yaml"));
    const webhooks = result.listed.filter((entry) => entry.kind === "webhook");
    expect(webhooks).toHaveLength(1);
    expect(result.tools.map((tool) => tool.name)).not.toContain(webhooks[0]!.name);
  });

  it("notes that Swagger 2.0 was converted in memory", async () => {
    const result = await importOpenApi(fixtureInput("swagger-2.0.yaml"));
    expect(result.notes).toContainEqual({
      tool: undefined,
      message: "Import converted the Swagger 2.0 document to OpenAPI 3.1 in memory. The file in the folder stays Swagger 2.0.",
    });
  });

  it("cuts each recursive schema at depth 4 with a note", async () => {
    const result = await importOpenApi(fixtureInput("recursive.yaml"));
    expect(result.notes.some((note) => /^Import cut the recursive schema \S+ at depth 4\.$/.test(note.message))).toBe(true);
  });
});

describe("the billing fixture", () => {
  const folder = `${FIXTURES}servers/billing/`;
  const text = readFileSync(`${folder}openapi.yaml`, "utf8");
  const upstream = JSON.parse(readFileSync(`${FIXTURES}expected/billing/upstream.json`, "utf8")) as unknown;
  const lock = JSON.parse(readFileSync(`${folder}tools.lock.json`, "utf8")) as {
    source: { document_hash: string; security_schemes: Record<string, unknown> };
  };
  const input = { files: [{ path: "openapi.yaml", text }], entry: "openapi.yaml", overlay: undefined };

  it("imports to expected/billing/upstream.json", async () => {
    const result = await importOpenApi(input);
    expect(plain(result.tools)).toStrictEqual(upstream);
  });

  it("hashes the document as tools.lock.json does", async () => {
    const result = await importOpenApi(input);
    expect(result.document_hash).toBe(lock.source.document_hash);
  });

  it("offers the auth scheme tools.lock.json pins", async () => {
    const result = await importOpenApi(input);
    const schemes = Object.fromEntries(result.auth.map(({ scheme, ...rest }) => [scheme, plain(rest)]));
    expect(schemes).toStrictEqual(lock.source.security_schemes);
  });

  it("records cursor paging on list_charges and none on the other tools", async () => {
    const result = await importOpenApi(input);
    const paging = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.paging ?? null]));
    expect(paging).toStrictEqual({
      list_charges: { style: "cursor", input: "cursor", next: "next_cursor", items: "data" },
      get_charge: null,
      create_refund: null,
    });
  });
});
