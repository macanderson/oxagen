import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// Fixed capability fixture: one non-agent (excluded), one low-risk agent,
// one high-risk agent.
const FIXTURE = [
  {
    name: "organization.create",
    description: "non-agent capability",
    surfaces: ["api", "mcp"] as const,
    input: z.object({}),
  },
  {
    name: "capA",
    description: "low risk agent cap",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "low" as const },
    input: z.object({ x: z.string() }),
  },
  {
    name: "capB",
    description: "high risk agent cap",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "high" as const },
    input: z.object({ y: z.number() }),
  },
];

vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: () => FIXTURE,
  getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
}));

vi.mock("../handlers/index.js", () => ({
  invokeCapability: vi.fn(async () => ({ ok: true })),
}));

const mocks = vi.hoisted(() => ({
  beforeTool: vi.fn(async () => undefined),
  afterTool: vi.fn(async () => undefined),
  onError: vi.fn(async () => undefined),
  createApprovalRequest: vi.fn(async () => ({ approvalId: "appr_x" })),
  waitForApproval: vi.fn(
    async (): Promise<{
      approvalId: string;
      resolution: "approved" | "denied" | "expired";
      note: null;
    }> => ({ approvalId: "appr_x", resolution: "approved", note: null }),
  ),
}));

vi.mock("../hooks/runtime.js", () => ({
  beforeTool: mocks.beforeTool,
  afterTool: mocks.afterTool,
  onError: mocks.onError,
}));

vi.mock("./approval.js", () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  waitForApproval: mocks.waitForApproval,
}));

import { materializeTools } from "./materialize-tools.js";
import { invokeCapability } from "../handlers/index.js";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("materializeTools", () => {
  beforeEach(() => {
    vi.mocked(invokeCapability).mockClear();
  });

  it("returns only agent-surfaced capabilities", async () => {
    const tools = await materializeTools(CTX);
    expect(Object.keys(tools).sort()).toEqual(["capA", "capB"]);
    expect(tools["organization.create"]).toBeUndefined();
  });

  it("filters by allowlist", async () => {
    const tools = await materializeTools(CTX, { allowlist: new Set(["capA"]) });
    expect(Object.keys(tools)).toEqual(["capA"]);
  });

  it("excludes capabilities above the risk ceiling", async () => {
    const tools = await materializeTools(CTX, { riskCeiling: "medium" });
    expect(tools.capA).toBeDefined();
    expect(tools.capB).toBeUndefined();
  });

  it("includes high risk when ceiling is high", async () => {
    const tools = await materializeTools(CTX, { riskCeiling: "high" });
    expect(tools.capB).toBeDefined();
  });

  it("produces AI SDK tools with description, parameters, and execute", async () => {
    const tools = await materializeTools(CTX);
    const t = tools.capA as { description?: string; parameters?: unknown; execute?: (i: unknown) => Promise<unknown> };
    expect(t.description).toBe("low risk agent cap");
    expect(t.parameters).toBeDefined();
    expect(typeof t.execute).toBe("function");
    await t.execute!({ x: "hello" });
    expect(invokeCapability).toHaveBeenCalledWith("capA", { x: "hello" }, CTX);
  });

  it("fires before/after hooks around a successful invocation", async () => {
    mocks.beforeTool.mockClear();
    mocks.afterTool.mockClear();
    mocks.onError.mockClear();
    const tools = await materializeTools(CTX);
    await (tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ x: "hi" });
    expect(mocks.beforeTool).toHaveBeenCalledTimes(1);
    expect(mocks.afterTool).toHaveBeenCalledTimes(1);
    expect(mocks.onError).not.toHaveBeenCalled();
  });

  it("fires onError when the handler throws", async () => {
    mocks.beforeTool.mockClear();
    mocks.afterTool.mockClear();
    mocks.onError.mockClear();
    vi.mocked(invokeCapability).mockRejectedValueOnce(new Error("boom"));
    const tools = await materializeTools(CTX);
    await expect(
      (tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ x: "hi" }),
    ).rejects.toThrow("boom");
    expect(mocks.beforeTool).toHaveBeenCalledTimes(1);
    expect(mocks.afterTool).not.toHaveBeenCalled();
    expect(mocks.onError).toHaveBeenCalledTimes(1);
  });

  it("requests approval when requiresApproval+messageId, blocks until approved", async () => {
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools.js");
    const tools = await mt({ ...CTX, messageId: "msg_42" });
    await (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 });
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mocks.waitForApproval).toHaveBeenCalledTimes(1);
  });

  it("denied approval throws and the handler never runs", async () => {
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    mocks.waitForApproval.mockResolvedValueOnce({
      approvalId: "appr_x",
      resolution: "denied",
      note: null,
    });
    vi.mocked(invokeCapability).mockClear();
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools.js");
    const tools = await mt({ ...CTX, messageId: "msg_42" });
    await expect(
      (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 }),
    ).rejects.toThrow(/approval denied/);
    expect(invokeCapability).not.toHaveBeenCalled();
  });

  it("no messageId → no approval request (direct MCP/API path)", async () => {
    mocks.createApprovalRequest.mockClear();
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools.js");
    const tools = await mt({ ...CTX, messageId: null });
    await (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 });
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });
});
