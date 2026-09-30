// Which Studio page a Tools path names (#4678), the links between its tabs,
// and the issue each unbuilt seam points at.
import { describe, expect, it } from "vitest";
import { studioGapRef } from "./gaps";
import { parseStudioRoute, STUDIO_TABS, studioHref } from "./route";

const AT = { org: "acme", ws: "core-platform" };

describe("parseStudioRoute", () => {
  it("leaves every path that is not a Studio page to the Tools tabs", () => {
    for (const segments of [
      undefined,
      [],
      ["servers"],
      ["tools"],
      ["policy", "mcs_01k5s1"],
    ]) {
      expect(parseStudioRoute(segments)).toBeUndefined();
    }
  });

  it("opens the Tools tab on a server's own path", () => {
    expect(parseStudioRoute(["servers", "mcs_01k5s1"])).toEqual({
      serverId: "mcs_01k5s1",
      tab: "tools",
    });
  });

  it("opens each of the four tabs by its segment", () => {
    for (const tab of STUDIO_TABS) {
      expect(parseStudioRoute(["servers", "mcs_01k5s1", tab])).toEqual({
        serverId: "mcs_01k5s1",
        tab,
      });
    }
  });

  it("answers a 404 for a bad id, an unknown tab or a deeper path", () => {
    for (const segments of [
      ["servers", "stripe"],
      ["servers", "mcs_"],
      ["servers", "mcs_01k5-s1"],
      ["servers", `mcs_${"a".repeat(65)}`],
      ["servers", "mcs_01k5s1", "settings"],
      ["servers", "mcs_01k5s1", "tools", "create_payment"],
    ]) {
      expect(parseStudioRoute(segments)).toBeNull();
    }
  });

  it("accepts an id body of 64 characters", () => {
    const serverId = `mcs_${"a".repeat(64)}`;
    expect(parseStudioRoute(["servers", serverId])).toEqual({
      serverId,
      tab: "tools",
    });
  });
});

describe("studioHref", () => {
  it("links the Tools tab to the server's own path", () => {
    expect(studioHref(AT, "mcs_01k5s1")).toBe(
      "/acme/core-platform/tools/servers/mcs_01k5s1",
    );
    expect(studioHref(AT, "mcs_01k5s1", "tools")).toBe(
      "/acme/core-platform/tools/servers/mcs_01k5s1",
    );
  });

  it("links every other tab one segment deeper", () => {
    expect(studioHref(AT, "mcs_01k5s1", "connection")).toBe(
      "/acme/core-platform/tools/servers/mcs_01k5s1/connection",
    );
    expect(studioHref(AT, "mcs_01k5s1", "try")).toBe(
      "/acme/core-platform/tools/servers/mcs_01k5s1/try",
    );
    expect(studioHref(AT, "mcs_01k5s1", "changes")).toBe(
      "/acme/core-platform/tools/servers/mcs_01k5s1/changes",
    );
  });

  it("round-trips through parseStudioRoute", () => {
    for (const tab of STUDIO_TABS) {
      const segments = studioHref(AT, "mcs_01k5s1", tab)
        .split("/")
        .slice(4);
      expect(parseStudioRoute(segments)).toEqual({
        serverId: "mcs_01k5s1",
        tab,
      });
    }
  });
});

describe("studioGapRef", () => {
  it("names the issue that owns each unbuilt seam", () => {
    expect(studioGapRef("record")).toBe("#4678");
  });
});
