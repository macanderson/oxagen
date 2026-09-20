import { describe, expect, it } from "vitest";
import { pathOf } from "@/shared/safe-path";
import { buildCommands, filterCommands, moveHighlight } from "./commands";

const labels = {
  nav: (key: string) => `nav:${key}`,
  create: (kind: string | null) => `create:${kind ?? "any"}`,
};

describe("buildCommands", () => {
  const commands = buildCommands({ org: "acme", ws: "core-platform" }, labels);

  it("offers the sidebar pages and the organization's other three, then Create", () => {
    const go = commands.filter((c) => "href" in c);
    expect(go.map((c) => c.href)).toEqual([
      "/acme/core-platform",
      "/acme/core-platform/agents",
      "/acme/core-platform/tools",
      "/acme/core-platform/steering",
      "/acme/core-platform/repositories",
      "/acme/core-platform/spend",
      "/acme",
      "/acme/roles",
      "/acme/api-keys",
      "/acme/model-funding",
      "/acme/billing",
      "/acme/audit",
    ]);
    expect(go.every((c) => c.id.startsWith("go:"))).toBe(true);
    expect(commands.map((c) => c.label)).toContain("nav:apiKeys");
    expect(commands.map((c) => c.label)).toContain("nav:roles");
    expect(commands.map((c) => c.label)).toContain("nav:modelFunding");
  });

  it("offers no Skills page: Skills is a tab of Steering (negative)", () => {
    expect(commands.find((c) => c.id === "go:skills")).toBeUndefined();
  });

  it("ends on Create: the chooser, then one entry per kind the shell hosts", () => {
    expect(commands.filter((c) => "create" in c)).toEqual([
      { id: "create", label: "create:any", create: null },
      { id: "create:agent", label: "create:agent", create: "agent" },
      { id: "create:skill", label: "create:skill", create: "skill" },
      { id: "create:record", label: "create:record", create: "record" },
    ]);
  });

  it("offers no workspace routes without a workspace (negative)", () => {
    const orgOnly = buildCommands({ org: "acme", ws: null }, labels);
    expect(orgOnly.every((c) => "href" in c)).toBe(true);
    expect(orgOnly.map((c) => ("href" in c ? c.href : null))).toEqual([
      "/acme",
      "/acme/roles",
      "/acme/api-keys",
      "/acme/model-funding",
      "/acme/billing",
      "/acme/audit",
    ]);
  });

  it("offers a page to go to or a wizard to open and nothing else: no Ontology graph question, no export (negative)", () => {
    for (const c of commands) {
      if ("href" in c) {
        expect(c.href).not.toMatch(/\/(ontology|export)(\/|$)/);
        expect(c.id).toMatch(/^go:/);
      } else {
        expect(c.id).toMatch(/^create(:|$)/);
      }
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
