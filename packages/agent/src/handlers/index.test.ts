import { describe, expect, it, vi } from "vitest";

// Stub the tool.list handler module so resolveHandler returns a known fn.
vi.mock("./agent.tool.list", () => ({
  agentToolListHandler: vi.fn(async () => ({ tools: [] })),
}));

import { resolveHandler, invokeCapability } from "./index";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

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

  // Exercise every agent-lifecycle loader so the lazy import() arrows are
  // covered and each handler module's expected export name is verified.
  it.each([
    "agent.definition.create",
    "agent.definition.update",
    "agent.definition.publish",
    "agent.definition.get",
    "agent.definition.list",
    "agent.deploy",
    "agent.trigger.create",
    "agent.trigger.update",
    "agent.trigger.delete",
    "agent.trigger.list",
  ])(
    "resolves a handler function for %s",
    async (cap) => {
      const fn = await resolveHandler(cap);
      expect(typeof fn).toBe("function");
    },
    // The first lazy import() cold-starts the module-graph transform; on a
    // loaded CI runner that can exceed vitest's 5s default. Give the dynamic
    // resolution a generous ceiling so it never flakes on a cold transform.
    30_000,
  );
});
