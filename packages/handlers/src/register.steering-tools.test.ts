// The steering tools' registrations (#5137): search_steering and read_steering
// each resolve a contract on the mcp surface and a handler, so the Cursor
// dashboard rule and the index lead name tools that exist.
import { getCapability, getSurfaces, hasHandler } from "@oxagen/oxagen";
import { CURSOR_DASHBOARD_RULE, INDEX_LEAD } from "@oxagen/steering-bundle";
import { describe, expect, it } from "vitest";

await import("./register");
await import("@oxagen/agent/register");

describe("the steering tool registrations", () => {
  it.each(["search_steering", "read_steering"])(
    "%s resolves its contract on the mcp surface and a handler",
    (name) => {
      const cap = getCapability(name);
      expect(cap?.name).toBe(name);
      expect(getSurfaces(cap as NonNullable<typeof cap>)).toEqual(["mcp"]);
      expect(hasHandler(name)).toBe(true);
    },
  );

  it("names only registered tools in the Cursor rule and the index lead", () => {
    for (const text of [CURSOR_DASHBOARD_RULE, INDEX_LEAD]) {
      for (const [name] of text.matchAll(/\b[a-z]+_steering\b/g)) {
        expect(hasHandler(name), name).toBe(true);
      }
    }
    expect(CURSOR_DASHBOARD_RULE).toContain("search_steering");
    expect(INDEX_LEAD).toContain("read_steering");
  });
});
