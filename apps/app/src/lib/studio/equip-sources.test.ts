/**
 * equip-sources.test.ts — unit tests for the Agent Builder Equip step's
 * source loaders.
 *
 * Each source degrades to an empty list on failure so the builder always
 * renders (never a blank wizard) — the primary regression this guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
  },
}));

vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          orderBy: (_o: unknown) => Promise.resolve(dbState.rows),
        }),
      }),
    }),
  });
  return {
    withTenantDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) => fn(makeTx())),
    schema: {
      pluginInstalledPlugins: {
        publicId: "pip_publicId",
        name: "pip_name",
        title: "pip_title",
        description: "pip_description",
        enabled: "pip_enabled",
        pluginType: "pip_pluginType",
        orgId: "pip_orgId",
        workspaceId: "pip_workspaceId",
        deletedAt: "pip_deletedAt",
      },
    },
  };
});

vi.mock("./tools", () => ({
  listAgentTools: vi.fn(),
}));
vi.mock("./agents", () => ({
  listAgents: vi.fn(),
}));

import { invoke } from "@oxagen/oxagen";
import { logger } from "@oxagen/handlers/logger";
import {
  listWorkspaceSkills,
  listInstalledMcpServers,
  loadEquipSources,
} from "./equip-sources";
import { listAgentTools } from "./tools";
import { listAgents } from "./agents";
import type { StudioCtx } from "./scope";

const mockInvoke = vi.mocked(invoke);
const mockListAgentTools = vi.mocked(listAgentTools);
const mockListAgents = vi.mocked(listAgents);

const ctx: StudioCtx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows = [];
});

describe("listWorkspaceSkills", () => {
  it("maps skill.workspace.list output ids to the agentTool ref shape", async () => {
    mockInvoke.mockResolvedValue({
      skills: [{ id: "skill_1", name: "Deploy", description: "Deploys things", enabled: true }],
    });

    const result = await listWorkspaceSkills(ctx);

    expect(mockInvoke).toHaveBeenCalledWith("list_workspace_skills", {}, ctx);
    expect(result).toEqual([
      { ref: "skill_1", name: "Deploy", description: "Deploys things", enabled: true },
    ]);
  });

  it("degrades to an empty pool and logs when the capability rejects", async () => {
    mockInvoke.mockRejectedValue(new Error("boom"));

    const result = await listWorkspaceSkills(ctx);

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("listInstalledMcpServers", () => {
  it("filters to mcp_server / mcp_server_local rows and maps to the ref shape", async () => {
    dbState.rows = [
      {
        publicId: "srv_1",
        name: "GitHub",
        title: "GitHub MCP",
        description: "Repo access",
        enabled: true,
        pluginType: "mcp_server",
      },
      {
        publicId: "srv_2",
        name: "Local Tool",
        title: null,
        description: null,
        enabled: false,
        pluginType: "mcp_server_local",
      },
      {
        publicId: "srv_3",
        name: "Not MCP",
        title: null,
        description: null,
        enabled: true,
        pluginType: "integration",
      },
    ];

    const result = await listInstalledMcpServers(ctx, "org-1", "ws-1");

    expect(result).toEqual([
      { ref: "srv_1", name: "GitHub", title: "GitHub MCP", description: "Repo access", enabled: true },
      { ref: "srv_2", name: "Local Tool", title: null, description: null, enabled: false },
    ]);
  });

  it("degrades to an empty pool and logs when the query throws", async () => {
    dbState.rows = [];
    const { withTenantDb } = await import("@oxagen/database");
    vi.mocked(withTenantDb).mockImplementationOnce(() => {
      throw new Error("connection lost");
    });

    const result = await listInstalledMcpServers(ctx, "org-1", "ws-1");

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("loadEquipSources", () => {
  it("combines all four pools and maps subagents to the ref/name/slug shape", async () => {
    mockInvoke.mockResolvedValue({ skills: [] });
    mockListAgentTools.mockResolvedValue([{ name: "get_pr" } as never]);
    mockListAgents.mockResolvedValue([
      { agentId: "a1", publicId: "pub_a1", slug: "researcher", name: "Researcher" } as never,
    ]);
    dbState.rows = [];

    const result = await loadEquipSources(ctx, "org-1", "ws-1");

    expect(result.skills).toEqual([]);
    expect(result.tools).toEqual([{ name: "get_pr" }]);
    expect(result.subagents).toEqual([{ ref: "pub_a1", name: "Researcher", slug: "researcher" }]);
    expect(result.mcp).toEqual([]);
  });
});
