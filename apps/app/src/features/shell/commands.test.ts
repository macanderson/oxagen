import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  buildCommands,
  filterCommands,
  groupCommands,
  moveHighlight,
} from "./commands";

const labels = {
  nav: (key: string) => `nav:${key}`,
  action: (id: string) => `action:${id}`,
  question: (id: string) => `Question ${id}?`,
};

const runs = [
  {
    id: "run_01K5RS7M2E8FJ3QW",
    workspace: "core-platform",
    agentKey: "acme.core.release-manager",
  },
];

describe("buildCommands", () => {
  const commands = buildCommands(
    { org: "acme", ws: "core-platform", runs },
    labels,
  );
  const byId = new Map(commands.map((c) => [c.id, c]));

  it("offers every page route", () => {
    expect(commands.filter((c) => c.group === "go").map((c) => c.href)).toEqual(
      [
        "/acme/core-platform",
        "/acme/core-platform/agents",
        "/acme/core-platform/tools",
        "/acme/core-platform/ontology",
        "/acme/core-platform/steering",
        "/acme/core-platform/spend",
        "/acme",
        "/acme/api-keys",
        "/acme/roles",
        "/acme/billing",
        "/acme/audit",
      ],
    );
  });

  it("opens recent runs in their own workspace", () => {
    expect(byId.get("run:run_01K5RS7M2E8FJ3QW")).toMatchObject({
      label: "run_01K5RS7M2E8FJ3QW",
      detail: "acme.core.release-manager",
      href: "/acme/core-platform/runs/run_01K5RS7M2E8FJ3QW",
    });
  });

  it("sends each action to the page where it runs", () => {
    expect(commands.filter((c) => c.group === "actions")).toHaveLength(
      ACTIONS.length,
    );
    expect(byId.get("action:registerAgent")?.href).toBe(
      "/acme/core-platform/register",
    );
    expect(byId.get("action:flipKillSwitch")?.href).toBe(
      "/acme/core-platform/tools/switches",
    );
    expect(byId.get("action:exportBundle")?.href).toBe("/acme/audit/exports");
    expect(byId.get("action:createApiKey")?.href).toBe("/acme/api-keys");
    expect(byId.get("action:steerFleet")?.href).toBe("/acme/core-platform");
  });

  it("asks the graph with the question encoded", () => {
    expect(byId.get("ask:triageWrites")?.href).toBe(
      "/acme/core-platform/ontology/graph?q=Question%20triageWrites%3F",
    );
  });

  it("offers no workspace commands without a workspace", () => {
    const orgOnly = buildCommands({ org: "acme", ws: null, runs: [] }, labels);
    expect(orgOnly.some((c) => c.href.startsWith("/acme/core-platform"))).toBe(
      false,
    );
    expect(orgOnly.some((c) => c.group === "ask")).toBe(false);
    expect(orgOnly.map((c) => c.id)).toContain("action:createRole");
    expect(orgOnly.map((c) => c.id)).not.toContain("action:registerAgent");
  });
});

describe("filterCommands", () => {
  const commands = buildCommands(
    { org: "acme", ws: "core-platform", runs },
    labels,
  );

  it("keeps everything for an empty query", () => {
    expect(filterCommands(commands, "   ")).toHaveLength(commands.length);
  });

  it("matches every term, case- and accent-insensitively, across label and detail", () => {
    expect(filterCommands(commands, "NAV:TOOLS").map((c) => c.id)).toEqual([
      "go:tools",
    ]);
    expect(
      filterCommands(commands, "release run_01k5").map((c) => c.id),
    ).toEqual(["run:run_01K5RS7M2E8FJ3QW"]);
    const accented = [
      {
        id: "x",
        group: "go" as const,
        label: "Politique générale",
        detail: null,
        href: "/x",
      },
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

describe("groupCommands", () => {
  it("orders groups and drops empty ones", () => {
    const commands = buildCommands({ org: "acme", ws: null, runs: [] }, labels);
    expect(groupCommands(commands).map((g) => g.group)).toEqual([
      "go",
      "actions",
    ]);
  });
});
