import { describe, expect, it } from "vitest";
import { pathOf } from "@/shared/safe-path";
import { buildCommands, filterCommands, moveHighlight } from "./commands";

const labels = { nav: (key: string) => `nav:${key}` };

describe("buildCommands", () => {
  const commands = buildCommands({ org: "acme", ws: "core-platform" }, labels);

  it("offers the eight sidebar pages and the organization's other two, and nothing else", () => {
    expect(commands.map((c) => c.href)).toEqual([
      "/acme/core-platform",
      "/acme/core-platform/agents",
      "/acme/core-platform/tools",
      "/acme/core-platform/skills",
      "/acme/core-platform/steering",
      "/acme/core-platform/spend",
      "/acme",
      "/acme/roles",
      "/acme/api-keys",
      "/acme/billing",
    ]);
    expect(commands.every((c) => c.id.startsWith("go:"))).toBe(true);
    expect(commands.map((c) => c.label)).toContain("nav:apiKeys");
    expect(commands.map((c) => c.label)).toContain("nav:roles");
  });

  it("offers go:skills to the workspace's Skills page under the Skills label", () => {
    expect(commands.find((c) => c.id === "go:skills")).toEqual({
      id: "go:skills",
      label: "nav:skills",
      href: "/acme/core-platform/skills",
    });
  });

  it("offers no workspace routes without a workspace (negative)", () => {
    const orgOnly = buildCommands({ org: "acme", ws: null }, labels);
    expect(orgOnly.map((c) => c.href)).toEqual([
      "/acme",
      "/acme/roles",
      "/acme/api-keys",
      "/acme/billing",
    ]);
  });

  it("offers no Ontology graph question and no Audit export (negative)", () => {
    for (const c of commands) {
      expect(c.href).not.toMatch(/\/(ontology|audit)(\/|$)/);
      expect(c.id).toMatch(/^go:/);
    }
  });
});

describe("filterCommands", () => {
  const commands = buildCommands({ org: "acme", ws: "core-platform" }, labels);

  it("keeps everything for an empty query", () => {
    expect(filterCommands(commands, "   ")).toHaveLength(commands.length);
  });

  it("matches every term, case- and accent-insensitively, against the label", () => {
    expect(filterCommands(commands, "NAV:TOOLS").map((c) => c.id)).toEqual([
      "go:tools",
    ]);
    const accented = [
      { id: "x", label: "Politique générale", href: pathOf("x") },
    ];
    expect(filterCommands(accented, "generale")).toHaveLength(1);
  });

  it("returns nothing when a term does not match", () => {
    expect(filterCommands(commands, "tools zebra")).toEqual([]);
  });
});

describe("moveHighlight", () => {
  it("wraps at both ends", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });

  it("starts from the nearest end when nothing is highlighted, and is -1 for an empty list", () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(1, 1, 0)).toBe(-1);
  });
});
