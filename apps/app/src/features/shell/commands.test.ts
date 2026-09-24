import { describe, expect, it } from "vitest";
import { pathOf } from "@/shared/safe-path";
import {
  buildCommands,
  COMMAND_GROUPS,
  type Command,
  filterCommands,
  fromSearchRows,
  moveHighlight,
  orderCommands,
  PAUSE_ALL_GAP,
  shortcutCommand,
} from "./commands";

const labels = {
  nav: (key: string) => `nav:${key}`,
  create: (kind: string | null) => `create:${kind ?? "any"}`,
  text: (key: string) => `text:${key}`,
};

const hrefs = (cs: readonly Command[]) =>
  cs.map((c) => ("href" in c ? c.href : null));

describe("buildCommands", () => {
  const commands = buildCommands({ org: "acme", ws: "core-platform" }, labels);
  const inGroup = (g: string) => commands.filter((c) => c.group === g);

  it("goes to every page, the five that carry ⌘1 to ⌘5 first", () => {
    const go = inGroup("go");
    expect(hrefs(go)).toEqual([
      "/acme/core-platform",
      "/acme/core-platform/agents",
      "/acme/core-platform/tools",
      "/acme/core-platform/steering",
      "/acme/core-platform/spend",
      "/acme/core-platform/runtimes",
      "/acme/core-platform/repositories",
      "/acme",
      "/acme/roles",
      "/acme/api-keys",
      "/acme/billing",
      "/acme/audit",
    ]);
    expect(go.every((c) => c.id.startsWith("go:"))).toBe(true);
    expect(
      go.map((c) => ("shortcut" in c ? (c.shortcut ?? null) : null)),
    ).toEqual([1, 2, 3, 4, 5, null, null, null, null, null, null, null]);
  });

  it("offers no Model funding or Single sign-on page: neither is a route in the design (negative)", () => {
    expect(commands.find((c) => c.id === "go:modelFunding")).toBeUndefined();
    expect(commands.find((c) => c.id === "go:sso")).toBeUndefined();
  });

  it("offers no Skills page: Skills is a tab of Steering (negative)", () => {
    expect(commands.find((c) => c.id === "go:skills")).toBeUndefined();
  });

  it("opens the assistant, drafts a question without sending it, and mints a model key on Model funding", () => {
    expect(inGroup("assistant")).toEqual([
      {
        id: "assistant:open",
        label: "text:assistant.open",
        group: "assistant",
        assistant: null,
      },
      {
        id: "assistant:tampered",
        label: "text:assistant.askTampered",
        group: "assistant",
        assistant: "text:assistant.askTamperedDraft",
      },
      {
        id: "assistant:cost",
        label: "text:assistant.askCost",
        group: "assistant",
        assistant: "text:assistant.askCostDraft",
      },
      {
        id: "assistant:key",
        label: "text:assistant.mintKey",
        group: "assistant",
        href: "/acme/model-funding",
      },
    ]);
  });

  it("offers Create: the chooser, then one entry per kind the shell hosts", () => {
    expect(inGroup("create")).toEqual([
      { id: "create", label: "create:any", group: "create", create: null },
      {
        id: "create:agent",
        label: "create:agent",
        group: "create",
        create: "agent",
      },
      {
        id: "create:skill",
        label: "create:skill",
        group: "create",
        create: "skill",
      },
      {
        id: "create:record",
        label: "create:record",
        group: "create",
        create: "record",
      },
    ]);
  });

  it("lists every governed action on the page that carries its write, and the one with no write disabled with its gap", () => {
    const actions = inGroup("actions");
    expect(actions.map((c) => c.id)).toEqual([
      "action:pause-all",
      "action:steer",
      "action:register",
      "action:grant",
      "action:role",
      "action:kill-switch",
      "action:export",
      "action:api-key",
    ]);
    expect(hrefs(actions)).toEqual([
      null,
      "/acme/core-platform",
      "/acme/core-platform/register/name",
      "/acme/core-platform/tools",
      "/acme/roles",
      "/acme/core-platform/tools/switches",
      "/acme/core-platform",
      "/acme/api-keys",
    ]);
    const pause = actions[0];
    expect(pause && "gap" in pause ? pause.gap : null).toBe(PAUSE_ALL_GAP);
    expect(pause?.detail).toBe("text:actions.pauseAllNotBacked");
  });

  it("offers no workspace page, assistant turn, wizard or workspace action without a workspace (negative)", () => {
    const orgOnly = buildCommands({ org: "acme", ws: null }, labels);
    expect(orgOnly.map((c) => c.id)).toEqual([
      "go:organization",
      "go:roles",
      "go:apiKeys",
      "go:billing",
      "go:audit",
      "assistant:key",
      "action:role",
      "action:api-key",
    ]);
  });

  it("carries no Ontology graph question and no export route (negative)", () => {
    for (const c of commands)
      if ("href" in c) expect(c.href).not.toMatch(/\/(ontology|export)(\/|$)/);
  });
});

describe("fromSearchRows", () => {
  it("builds each search_tools row's target from the route builders, never from the row", () => {
    const rows = fromSearchRows(
      [
        { kind: "run", id: "arun_1", label: "Run one", contextLine: "live" },
        { kind: "agent", id: "agt_1", label: "triage", contextLine: null },
        { kind: "approval", id: "apr_1", label: "stripe", contextLine: "4:10" },
        {
          kind: "tool",
          id: "list_runs",
          label: "list_runs",
          contextLine: "List runs",
        },
      ],
      { org: "acme", ws: "core-platform" },
    );
    expect(rows.map((c) => c.group)).toEqual([
      "runs",
      "agents",
      "approvals",
      "tools",
    ]);
    expect(hrefs(rows)).toEqual([
      "/acme/core-platform/runs/arun_1",
      "/acme/core-platform/agents/agt_1",
      null,
      "/acme/core-platform/tools",
    ]);
    expect(rows[2] && "approvals" in rows[2]).toBe(true);
    expect(rows[0]?.detail).toBe("live");
    expect(rows[1]?.detail).toBeUndefined();
  });
});

describe("orderCommands", () => {
  it("sorts into the menu's group order and keeps each group's own order", () => {
    const search = fromSearchRows(
      [{ kind: "tool", id: "t", label: "t", contextLine: null }],
      { org: "acme", ws: "core-platform" },
    );
    const built = buildCommands({ org: "acme", ws: "core-platform" }, labels);
    const ordered = orderCommands([...search, ...built]);
    const seen = [...new Set(ordered.map((c) => c.group))];
    expect(seen).toEqual(COMMAND_GROUPS.filter((g) => seen.includes(g)));
    expect(ordered.at(-1)?.group).toBe("tools");
    expect(ordered[0]?.id).toBe("go:fleet");
  });
});

describe("shortcutCommand", () => {
  const commands = buildCommands({ org: "acme", ws: "core-platform" }, labels);

  it("finds the page a digit opens", () => {
    expect(shortcutCommand(commands, 1)?.id).toBe("go:fleet");
    expect(shortcutCommand(commands, 5)?.id).toBe("go:spend");
  });

  it("finds nothing for a digit no page carries, or without a workspace (negative)", () => {
    expect(shortcutCommand(commands, 6)).toBeNull();
    expect(
      shortcutCommand(buildCommands({ org: "acme", ws: null }, labels), 1),
    ).toBeNull();
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
    const accented: Command[] = [
      { id: "x", label: "Politique générale", group: "go", href: pathOf("x") },
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
