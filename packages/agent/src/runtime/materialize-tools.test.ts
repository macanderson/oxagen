import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// Fixed capability fixture: one non-agent (excluded), one low-risk agent,
// one high-risk agent, one non-agent.* agent-surface capability (form.fill).
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
  {
    // Non-agent.* name but surfaced on agent — this is the gap-1 scenario.
    name: "form.fill",
    description: "fill a form with AI-proposed values",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "low" as const },
    input: z.object({ formId: z.string(), values: z.record(z.unknown()) }),
  },
];

vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: () => FIXTURE,
  getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(async () => ({ ok: true })),
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

vi.mock("../hooks/runtime", () => ({
  beforeTool: mocks.beforeTool,
  afterTool: mocks.afterTool,
  onError: mocks.onError,
}));

vi.mock("./approval", () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  waitForApproval: mocks.waitForApproval,
}));

import { materializeTools } from "./materialize-tools";
import { invoke } from "@oxagen/oxagen/kernel";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("materializeTools", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("returns only agent-surfaced capabilities", async () => {
    const tools = await materializeTools(CTX);
    expect(Object.keys(tools).sort()).toEqual(["capA", "capB", "form.fill"]);
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
    expect(invoke).toHaveBeenCalledWith("capA", { x: "hello" }, CTX, { surface: "agent" });
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
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
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
    const { materializeTools: mt } = await import("./materialize-tools");
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
    vi.mocked(invoke).mockClear();
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const tools = await mt({ ...CTX, messageId: "msg_42" });
    await expect(
      (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 }),
    ).rejects.toThrow(/approval denied/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("form.fill (non-agent.* name) dispatches through kernel invoke without 'No handler registered'", async () => {
    // This is the gap-1 regression test. Prior to the fix, the tool execute
    // used invokeCapability (agent-internal, only covers agent.*) instead of
    // the shared kernel invoke. This test asserts that a non-agent.* capability
    // that is surfaced on agent resolves end-to-end through kernel invoke.
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({ filled: true });
    const tools = await materializeTools(CTX);
    const formFillTool = tools["form.fill"] as { execute?: (i: unknown) => Promise<unknown> };
    expect(formFillTool).toBeDefined();
    const result = await formFillTool.execute!({ formId: "workspace-general", values: { name: "Prod" } });
    // Kernel invoke must have been called — not the agent-internal loader
    expect(invoke).toHaveBeenCalledWith(
      "form.fill",
      { formId: "workspace-general", values: { name: "Prod" } },
      CTX,
      { surface: "agent" },
    );
    expect(result).toEqual({ filled: true });
  });

  it("svg.generate (non-agent.* name) dispatches through kernel invoke without 'No handler registered'", async () => {
    // Second non-agent.* capability from the gap-1 list to confirm pattern.
    // We use the FIXTURE as-is (svg.generate is not in FIXTURE); instead we
    // use the already-present form.fill fixture entry and verify kernel
    // invoke is the dispatch path for any non-agent.* agent-surface capability.
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({ svg: "<svg/>" });
    const customFixture = [
      {
        name: "svg.generate",
        description: "generate an svg",
        surfaces: ["agent"] as const,
        agent: { riskLevel: "low" as const },
        input: z.object({ prompt: z.string() }),
      },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => customFixture,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const tools = await mt(CTX);
    const svgTool = tools["svg.generate"] as { execute?: (i: unknown) => Promise<unknown> };
    expect(svgTool).toBeDefined();
    const result = await svgTool.execute!({ prompt: "a red circle" });
    expect(invoke).toHaveBeenCalledWith(
      "svg.generate",
      { prompt: "a red circle" },
      CTX,
      { surface: "agent" },
    );
    expect(result).toEqual({ svg: "<svg/>" });
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
    const { materializeTools: mt } = await import("./materialize-tools");
    const tools = await mt({ ...CTX, messageId: null });
    await (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 });
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });
});
