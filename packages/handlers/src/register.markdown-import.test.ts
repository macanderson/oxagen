// The Markdown import's registrations (#4907): both new capabilities resolve
// a contract and a handler, and the Neo4j import pair they replace resolves a
// contract on no surface and no handler (DEREGISTERED.md §8).
import { getCapability, getSurfaces, hasHandler } from "@oxagen/oxagen";
import { describe, expect, it } from "vitest";

await import("./register");
await import("@oxagen/agent/register");

describe("the Markdown import registrations", () => {
  it.each(["parse_markdown_import", "commit_markdown_import"])(
    "%s resolves its contract and a handler",
    (name) => {
      expect(getCapability(name)?.name).toBe(name);
      expect(hasHandler(name)).toBe(true);
    },
  );

  it.each(["parse_memory_import", "commit_memory_import"])(
    "%s is retired: on no surface, with no handler",
    (name) => {
      const cap = getCapability(name);
      expect(cap).toBeDefined();
      expect(getSurfaces(cap as NonNullable<typeof cap>)).toEqual([]);
      expect(hasHandler(name)).toBe(false);
    },
  );
});
