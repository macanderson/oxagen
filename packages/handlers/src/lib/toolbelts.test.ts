// The belt rule every toolbelt reader goes through (ADR-192): which tools a
// belt holds and which it shows, and how a server named by public id is
// resolved. Pure functions over rows; the handlers' Postgres suites prove the
// reads that feed them.
import { describe, expect, it } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import {
  beltDenyPatterns,
  beltToolStates,
  resolveServerKey,
  serverKeyOf,
  type ToolServer,
  type WorkspaceTool,
} from "./toolbelts";

const tool = (
  id: string,
  over: Partial<WorkspaceTool> = {},
): WorkspaceTool => ({
  id,
  publicId: `tol_${id}`,
  slug: id,
  name: id,
  description: null,
  source: "mcp",
  available: true,
  defaultActive: true,
  mcpServerId: "srv-github",
  ...over,
});

const TOOLS = [
  tool("create_issue"),
  tool("delete_repo", { defaultActive: false }),
  tool("drop_table", { available: false, mcpServerId: "srv-db" }),
  tool("summarize", { source: "custom", mcpServerId: null }),
];

describe("beltToolStates", () => {
  it("the All tools belt holds every tool and shows each available one its default says", () => {
    const states = beltToolStates({ kind: "all_tools" }, TOOLS, new Map());
    expect(states.map((s) => [s.tool.id, s.member, s.active])).toEqual([
      ["create_issue", true, true],
      ["delete_repo", true, false],
      ["drop_table", true, false],
      ["summarize", true, true],
    ]);
  });

  it("a custom belt holds only its rows and shows a row only while its tool is available", () => {
    const members = new Map([
      ["create_issue", false],
      ["delete_repo", true],
      ["drop_table", true],
    ]);
    const states = beltToolStates({ kind: "custom" }, TOOLS, members);
    expect(states.map((s) => [s.tool.id, s.member, s.active])).toEqual([
      ["create_issue", true, false],
      // A clone can turn on a tool that starts off in the All tools belt.
      ["delete_repo", true, true],
      // An unavailable tool is out of every belt, whatever the row says.
      ["drop_table", true, false],
      ["summarize", false, false],
    ]);
  });
});

describe("beltDenyPatterns", () => {
  const servers = new Map<string, ToolServer>([
    [
      "srv-github",
      { id: "srv-github", publicId: "mcs_github", name: "github" },
    ],
    ["srv-db", { id: "srv-db", publicId: "mcs_db", name: "postgres" }],
  ]);

  it("names every imported MCP tool the belt does not show, as server:tool", () => {
    const states = beltToolStates({ kind: "all_tools" }, TOOLS, new Map());
    expect(beltDenyPatterns(states, servers)).toEqual([
      "github:delete_repo",
      "postgres:drop_table",
    ]);
  });

  it("names a whole removed server tool by tool, and never a declared tool", () => {
    const states = beltToolStates(
      { kind: "custom" },
      TOOLS,
      new Map([["create_issue", true]]),
    );
    expect(beltDenyPatterns(states, servers)).toEqual([
      "github:delete_repo",
      "postgres:drop_table",
    ]);
  });

  it("names nothing when the belt shows every imported tool", () => {
    const states = beltToolStates(
      { kind: "custom" },
      [tool("create_issue")],
      new Map([["create_issue", true]]),
    );
    expect(beltDenyPatterns(states, servers)).toEqual([]);
  });

  it("skips a tool whose server is not among the live servers", () => {
    const states = beltToolStates(
      { kind: "custom" },
      [tool("orphan", { mcpServerId: "srv-gone" })],
      new Map(),
    );
    expect(beltDenyPatterns(states, servers)).toEqual([]);
  });
});

describe("server keys", () => {
  const servers = new Map<string, ToolServer>([
    [
      "srv-github",
      { id: "srv-github", publicId: "mcs_github", name: "github" },
    ],
  ]);

  it("groups a declared tool under the empty key and an MCP tool under its server", () => {
    expect(serverKeyOf({ mcpServerId: null })).toBe("");
    expect(serverKeyOf({ mcpServerId: "srv-github" })).toBe("srv-github");
  });

  it("resolves a server's public id, and null to the declared tools", () => {
    expect(resolveServerKey(servers, "mcs_github")).toBe("srv-github");
    expect(resolveServerKey(servers, null)).toBe("");
  });

  it("refuses a server the workspace does not hold", () => {
    expect(() => resolveServerKey(servers, "mcs_other")).toThrow();
    try {
      resolveServerKey(servers, "mcs_other");
    } catch (err) {
      expect(
        isHandlerError(err) &&
          err.code === "not_found" &&
          err.reason === "tool_server_not_found",
      ).toBe(true);
    }
  });
});
