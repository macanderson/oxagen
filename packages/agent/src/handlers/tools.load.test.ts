import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const REGISTRY = [
  {
    name: "list_runs",
    description: "List the runs",
    surfaces: ["api", "mcp", "agent"],
    input: z.object({ limit: z.number().int().optional() }),
    mutates: false,
    agent: { riskLevel: "low", requiresApproval: false },
  },
  {
    name: "set_budget",
    description: "Set a budget",
    surfaces: ["api", "agent"],
    input: z.object({ usd: z.number() }),
    agent: { riskLevel: "high", requiresApproval: true },
  },
  {
    name: "set_org_billing_terms",
    description: "Operator only",
    surfaces: ["api"],
    input: z.object({}),
  },
];

const mocks = vi.hoisted(() => ({
  pluginForContract: vi.fn(
    (_name: string): { id: string } | undefined => undefined,
  ),
  listEntitled: vi.fn(async () => new Set<string>()),
}));

vi.mock("@oxagen/oxagen/plugins", () => ({
  pluginForContract: mocks.pluginForContract,
}));
vi.mock("@oxagen/plugins", () => ({
  listEntitledCapabilityPluginIds: mocks.listEntitled,
}));
vi.mock("../registry-loader", () => ({
  getOxagenRegistry: async () => ({
    listCapabilities: () => REGISTRY,
    getSurfaces: (c: { surfaces: string[] }) => c.surfaces,
    getCapability: (name: string) => REGISTRY.find((c) => c.name === name),
  }),
}));

import { toolsLoadHandler } from "./tools.load";

const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "r-1",
  surface: "api" as const,
  messageId: null,
};

describe("load_tools", () => {
  beforeEach(() => {
    mocks.pluginForContract.mockReset().mockReturnValue(undefined);
    mocks.listEntitled.mockReset().mockResolvedValue(new Set<string>());
  });
  it("describes named capabilities on the agent surface with their schema and governance facts", async () => {
    const out = await toolsLoadHandler(
      { names: ["set_budget", "list_runs"] },
      CTX,
    );
    expect(out.unknown).toEqual([]);
    expect(out.tools).toEqual([
      {
        name: "set_budget",
        description: "Set a budget",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { usd: { type: "number" } },
        }),
        riskLevel: "high",
        requiresApproval: true,
        readOnly: false,
      },
      {
        name: "list_runs",
        description: "List the runs",
        inputSchema: expect.objectContaining({ type: "object" }),
        riskLevel: "low",
        requiresApproval: false,
        readOnly: true,
      },
    ]);
  });

  it("reports a name outside the belt as unknown and describes nothing for it (negative)", async () => {
    const out = await toolsLoadHandler(
      { names: ["set_org_billing_terms", "delete_everything"] },
      CTX,
    );
    expect(out).toEqual({
      tools: [],
      unknown: ["set_org_billing_terms", "delete_everything"],
    });
  });
  it("reports a capability claimed by a plugin the org has not installed as unknown (negative)", async () => {
    mocks.pluginForContract.mockImplementation((name: string) =>
      name === "set_budget" ? { id: "oxagen/budgets" } : undefined,
    );
    mocks.listEntitled.mockResolvedValue(new Set<string>());
    const out = await toolsLoadHandler(
      { names: ["set_budget", "list_runs"] },
      CTX,
    );
    expect(out.tools.map((t) => t.name)).toEqual(["list_runs"]);
    expect(out.unknown).toEqual(["set_budget"]);
    expect(mocks.listEntitled).toHaveBeenCalledWith("org-1", "ws-1");
  });

  it("reports every plugin-claimed capability as unknown when the entitlement read fails (fail-closed)", async () => {
    mocks.pluginForContract.mockImplementation((name: string) =>
      name === "set_budget" ? { id: "oxagen/budgets" } : undefined,
    );
    mocks.listEntitled.mockRejectedValue(new Error("DB unavailable"));
    const out = await toolsLoadHandler({ names: ["set_budget"] }, CTX);
    expect(out).toEqual({ tools: [], unknown: ["set_budget"] });
  });
});
