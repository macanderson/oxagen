import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// Fixed capability fixture: one non-agent (excluded), one low-risk agent,
// one high-risk agent.
const FIXTURE = [
  {
    name: "tenant.create",
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

import { materializeTools } from "./materialize-tools.js";
import { invokeCapability } from "../handlers/index.js";

const CTX = {
  tenantId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
};

describe("materializeTools", () => {
  beforeEach(() => {
    vi.mocked(invokeCapability).mockClear();
  });

  it("returns only agent-surfaced capabilities", async () => {
    const tools = await materializeTools(CTX);
    expect(Object.keys(tools).sort()).toEqual(["capA", "capB"]);
    expect(tools["tenant.create"]).toBeUndefined();
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
});
