/**
 * hosted-schemas.test.ts — Guards the contract `schemas.oxagen.sh` publishes:
 * every JSON Schema in `public/` is valid JSON, declares the `$id` it is
 * actually served under, and is linked from the index page. A schema added to
 * `public/` without an index entry (or with an `$id` pointing at the wrong
 * URL) fails here rather than silently shipping a document editors cannot
 * resolve.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

const BASE_URL = "https://schemas.oxagen.sh";

interface HostedSchema {
  $id?: unknown;
  title?: unknown;
  description?: unknown;
}

function hostedSchemaFiles(): string[] {
  return readdirSync(publicDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readIndexHtml(): string {
  return readFileSync(join(publicDir, "index.html"), "utf8");
}

describe("hosted schemas", () => {
  it("are valid JSON documents served under their own $id", () => {
    for (const name of hostedSchemaFiles()) {
      const raw = readFileSync(join(publicDir, name), "utf8");
      const parsed = JSON.parse(raw) as HostedSchema;

      expect(parsed.$id).toBe(`${BASE_URL}/${name}`);
      expect(typeof parsed.title).toBe("string");
      expect(typeof parsed.description).toBe("string");
    }
  });

  it("are exactly the schemas the index page links", () => {
    const html = readIndexHtml();
    const linked = [...html.matchAll(/href="\/([^"]+\.json)"/g)]
      .map((match) => match[1] ?? "")
      .sort();

    expect(linked).toStrictEqual(hostedSchemaFiles());
  });
});
