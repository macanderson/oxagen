// The runtime, toolbelt and agent-version tools (ADR-192, #4369). Each one is a
// thin adapter: build the context, invoke the contract by its registered
// name on the `mcp` surface, and parse the output through the contract.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { obj } from "./_schema-test-helpers";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import agentMoveTool, * as agentMoveModule from "./agent.move";
import agentToolbeltAssignTool, * as agentToolbeltAssignModule from "./agent.toolbelt.assign";
import runtimeCreateTool, * as runtimeCreateModule from "./runtime.create";
import runtimeListTool, * as runtimeListModule from "./runtime.list";
import toolStateSetTool, * as toolStateSetModule from "./tool.state.set";
import toolbeltCloneTool, * as toolbeltCloneModule from "./toolbelt.clone";
import toolbeltDeleteTool, * as toolbeltDeleteModule from "./toolbelt.delete";
import toolbeltGetTool, * as toolbeltGetModule from "./toolbelt.get";
import toolbeltListTool, * as toolbeltListModule from "./toolbelt.list";
import toolbeltUpdateTool, * as toolbeltUpdateModule from "./toolbelt.update";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const RUNTIME = {
  id: "rtm_0123456789abcdefghjkmn",
  name: "Mac's laptop",
  slug: "macs-laptop",
};
const BELT = {
  id: "tbt_0123456789abcdefghjkmn",
  name: "All tools",
  slug: "all-tools",
  kind: "all_tools" as const,
};
const AT = "2026-09-25T12:00:00.000Z";

/** Each tool takes its own args type; the table only forwards them. */
type AnyTool = (args: Record<string, unknown>) => Promise<unknown>;
const asTool = (tool: unknown): AnyTool => tool as AnyTool;

interface Case {
  name: string;
  tool: AnyTool;
  schema: z.ZodRawShape;
  metadataName: string;
  args: Record<string, unknown>;
  output: unknown;
}

const CASES: Case[] = [
  {
    name: "create_runtime",
    tool: asTool(runtimeCreateTool),
    schema: runtimeCreateModule.schema,
    metadataName: runtimeCreateModule.metadata.name,
    args: { name: "Mac's laptop" },
    output: { runtime: RUNTIME },
  },
  {
    name: "list_runtimes",
    tool: asTool(runtimeListTool),
    schema: runtimeListModule.schema,
    metadataName: runtimeListModule.metadata.name,
    args: {},
    output: {
      items: [
        {
          ...RUNTIME,
          createdAt: AT,
          agents: [],
          liveHosts: 0,
          lastSeenAt: null,
        },
      ],
    },
  },
  {
    name: "list_toolbelts",
    tool: asTool(toolbeltListTool),
    schema: toolbeltListModule.schema,
    metadataName: toolbeltListModule.metadata.name,
    args: {},
    output: {
      items: [
        {
          ...BELT,
          description: null,
          clonedFrom: null,
          tools: 0,
          activeTools: 0,
          servers: 0,
          agents: 0,
          updatedAt: AT,
        },
      ],
      availableTools: 0,
    },
  },
  {
    name: "get_toolbelt",
    tool: asTool(toolbeltGetTool),
    schema: toolbeltGetModule.schema,
    metadataName: toolbeltGetModule.metadata.name,
    args: { toolbeltId: BELT.id },
    output: {
      toolbelt: { ...BELT, description: null, clonedFrom: null, updatedAt: AT },
      groups: [],
      agents: [],
    },
  },
  {
    name: "clone_toolbelt",
    tool: asTool(toolbeltCloneTool),
    schema: toolbeltCloneModule.schema,
    metadataName: toolbeltCloneModule.metadata.name,
    args: { toolbeltId: BELT.id, name: "Read only" },
    output: {
      toolbelt: {
        id: "tbt_1abcdefghjkmnpqrstvwxy",
        name: "Read only",
        slug: "read-only",
        kind: "custom",
      },
    },
  },
  {
    name: "update_toolbelt",
    tool: asTool(toolbeltUpdateTool),
    schema: toolbeltUpdateModule.schema,
    metadataName: toolbeltUpdateModule.metadata.name,
    args: {
      toolbeltId: BELT.id,
      changes: [{ op: "remove_server", serverId: null }],
    },
    output: { toolbelt: { ...BELT, kind: "custom" } },
  },
  {
    name: "delete_toolbelt",
    tool: asTool(toolbeltDeleteTool),
    schema: toolbeltDeleteModule.schema,
    metadataName: toolbeltDeleteModule.metadata.name,
    args: { toolbeltId: BELT.id },
    output: { toolbeltId: BELT.id, deleted: true },
  },
  {
    name: "set_tool_state",
    tool: asTool(toolStateSetTool),
    schema: toolStateSetModule.schema,
    metadataName: toolStateSetModule.metadata.name,
    args: { serverId: null, available: false },
    output: { updated: 2 },
  },
  {
    name: "move_agent",
    tool: asTool(agentMoveTool),
    schema: agentMoveModule.schema,
    metadataName: agentMoveModule.metadata.name,
    args: { agentId: "agt_1", runtimeId: RUNTIME.id },
    output: { agentId: "agt_1", runtime: RUNTIME, version: 2, revokedHosts: 1 },
  },
  {
    name: "assign_agent_toolbelt",
    tool: asTool(agentToolbeltAssignTool),
    schema: agentToolbeltAssignModule.schema,
    metadataName: agentToolbeltAssignModule.metadata.name,
    args: { agentId: "agt_1", toolbeltId: BELT.id },
    output: { agentId: "agt_1", toolbelt: BELT, version: 3 },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("runtime and toolbelt tools", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s names its contract and accepts the args it forwards",
    (name, entry) => {
      expect(entry.metadataName).toBe(name);
      expect(() => obj(entry.schema).parse(entry.args)).not.toThrow();
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s invokes its contract on the mcp surface and parses the output",
    async (name, entry) => {
      mocks.invoke.mockResolvedValue(entry.output);
      const result = await entry.tool(entry.args);
      expect(mocks.buildContext).toHaveBeenCalledOnce();
      expect(mocks.invoke).toHaveBeenCalledWith(name, entry.args, fakeCtx, {
        surface: "mcp",
      });
      expect(result).toEqual(entry.output);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s refuses an output its contract does not accept",
    async (_name, entry) => {
      mocks.invoke.mockResolvedValue({ unexpected: true });
      await expect(entry.tool(entry.args)).rejects.toThrow();
    },
  );

  it("set_tool_state lists the contract's fields without its refinements", () => {
    const schema = obj(toolStateSetModule.schema);
    // Both targets at once passes the tool schema; the kernel's parse of the
    // contract refuses it when the call is invoked.
    expect(() =>
      schema.parse({ toolIds: ["tol_1"], serverId: null, available: true }),
    ).not.toThrow();
  });
});
