import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import {
  mcpToolName,
  filterServerTools,
  buildServerReport,
  materializeServerTools,
  loadMcpTools,
  type McpClientLike,
} from "../client.js";
import type { OxagenSettings } from "../../settings/schema.js";

const TOOLS = ["create_issue", "delete_repo", "list_issues"];

function fakeClient(
  calls: Array<{ name: string; args: unknown }> = [],
): McpClientLike {
  return {
    listTools: async () => ({ tools: TOOLS.map((name) => ({ name })) }),
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
    close: async () => {},
  };
}

type Exec = NonNullable<ToolSet[string]["execute"]>;
const CALL_OPTS = {
  toolCallId: "t",
  messages: [],
} as unknown as Parameters<Exec>[1];

describe("mcpToolName", () => {
  it("uses the mcp__server__tool convention", () => {
    expect(mcpToolName("github", "create_issue")).toBe(
      "mcp__github__create_issue",
    );
  });
});

describe("filterServerTools", () => {
  it("passes everything with no rules", () => {
    expect(filterServerTools("github", TOOLS, {}).sort()).toEqual(
      [...TOOLS].sort(),
    );
  });

  it("applies toolVisibility include/exclude", () => {
    const settings: OxagenSettings = {
      toolVisibility: { github: { exclude: ["delete_*"] } },
    };
    expect(filterServerTools("github", TOOLS, settings)).not.toContain(
      "delete_repo",
    );
    expect(filterServerTools("github", TOOLS, settings)).toContain(
      "create_issue",
    );
  });

  it("removes tools denied by per-server permissions", () => {
    const settings: OxagenSettings = {
      permissions: { mcpServers: { github: { deny: ["delete_*"] } } },
    };
    expect(filterServerTools("github", TOOLS, settings)).not.toContain(
      "delete_repo",
    );
  });
});

describe("buildServerReport", () => {
  it("classifies tools into advertised / hidden / denied", () => {
    const settings: OxagenSettings = {
      toolVisibility: { github: { exclude: ["list_*"] } },
      permissions: { mcpServers: { github: { deny: ["delete_*"] } } },
    };
    const r = buildServerReport("github", TOOLS, settings);
    expect(r.advertised).toEqual(["create_issue"]);
    expect(r.hidden).toEqual(["list_issues"]);
    expect(r.denied).toEqual(["delete_repo"]);
  });
});

describe("materializeServerTools", () => {
  it("wraps only allowed tools, names them mcp__server__tool, and routes execute to callTool", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const settings: OxagenSettings = {
      permissions: { mcpServers: { github: { deny: ["delete_*"] } } },
    };
    const tools = await materializeServerTools(
      fakeClient(calls),
      "github",
      settings,
    );
    expect(Object.keys(tools).sort()).toEqual([
      "mcp__github__create_issue",
      "mcp__github__list_issues",
    ]);
    expect(tools).not.toHaveProperty("mcp__github__delete_repo");

    const exec = tools["mcp__github__create_issue"]!.execute as Exec;
    const result = await exec({ title: "x" } as never, CALL_OPTS);
    expect(result).toBe("ran create_issue");
    expect(calls).toEqual([{ name: "create_issue", args: { title: "x" } }]);
  });

  it("surfaces MCP error results with a prefix", async () => {
    const client: McpClientLike = {
      listTools: async () => ({ tools: [{ name: "boom" }] }),
      callTool: async () => ({
        content: [{ type: "text", text: "kaboom" }],
        isError: true,
      }),
      close: async () => {},
    };
    const tools = await materializeServerTools(client, "x", {});
    const exec = tools["mcp__x__boom"]!.execute as Exec;
    expect(await exec({} as never, CALL_OPTS)).toContain(
      "MCP tool error: kaboom",
    );
  });
});

describe("loadMcpTools", () => {
  it("skips disabled servers", async () => {
    const settings: OxagenSettings = {
      mcpServers: {
        off: { transport: "stdio", command: "true", args: [], disabled: true },
      },
    };
    const loaded = await loadMcpTools(settings);
    expect(loaded.servers).toEqual([]);
    expect(Object.keys(loaded.tools)).toEqual([]);
    await loaded.close();
  });

  it("isolates a server that fails to connect (never throws)", async () => {
    const settings: OxagenSettings = {
      mcpServers: {
        broken: {
          transport: "stdio",
          command: "oxagen-no-such-binary-xyz",
          args: [],
        },
      },
    };
    const statuses: string[] = [];
    const loaded = await loadMcpTools(settings, {
      onStatus: (s) => statuses.push(s.name),
    });
    expect(loaded.servers).toHaveLength(1);
    expect(loaded.servers[0]?.ok).toBe(false);
    expect(loaded.servers[0]?.error).toBeTruthy();
    expect(statuses).toEqual(["broken"]);
    await loaded.close();
  });
});
