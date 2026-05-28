import { describe, expect, it, vi } from "vitest";

// Stub the tool.list handler module so resolveHandler returns a known fn.
vi.mock("./agent.tool.list.js", () => ({
  agentToolListHandler: vi.fn(async () => ({ tools: [] })),
}));

import { resolveHandler, invokeCapability } from "./index.js";

const CTX = {
  tenantId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("handler registry", () => {
  it("resolveHandler returns a function for a registered capability", async () => {
    const fn = await resolveHandler("agent.tool.list");
    expect(typeof fn).toBe("function");
  });

  it("resolveHandler throws for an unknown capability", async () => {
    await expect(resolveHandler("does.not.exist")).rejects.toThrow(/No handler registered/);
  });

  it("invokeCapability dispatches through the resolved handler", async () => {
    const res = await invokeCapability("agent.tool.list", { includeExternal: false }, CTX);
    expect(res).toEqual({ tools: [] });
  });
});
