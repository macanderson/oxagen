import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, EMBEDDING_INDEXES } from "./migrate";

// schema.cypher is the index contract with packages/ai/src/embed.ts: every
// vector it stores is EMBEDDING_DIMENSIONS long (#4148). A size here that
// differs from the model's would leave every new vector out of its index.
const schema = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "schema.cypher"),
  "utf8",
);

describe("schema.cypher vector indexes", () => {
  it("sizes every vector index to the embedding model's dimensions", () => {
    const sizes = [...schema.matchAll(/`vector\.dimensions`:\s*(\d+)/g)].map(
      (m) => Number(m[1]),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(new Set(sizes)).toEqual(new Set([EMBEDDING_DIMENSIONS]));
  });

  it("creates exactly the indexes the migrator resizes", () => {
    const created = [
      ...schema.matchAll(/CREATE VECTOR INDEX (\w+) IF NOT EXISTS/g),
    ].map((m) => m[1]);
    expect(new Set(created)).toEqual(new Set(EMBEDDING_INDEXES));
  });
});
