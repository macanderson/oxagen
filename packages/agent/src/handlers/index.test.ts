import { describe, expect, it, vi } from "vitest";

// Stub the tool.list handler module so resolveHandler returns a known fn.
// resolveHandler first probes the name derived from the capability
// ("list_agent_tools" → "list_agent_toolsHandler"); a vitest mock THROWS on
// undefined exports (unlike a real module), so the mock must define the
// derived name too, aliased to the module's readable export.
vi.mock("./agent.tool.list", () => {
  const agentToolListHandler = vi.fn(async () => ({ tools: [] }));
  return {
    agentToolListHandler,
    list_agent_toolsHandler: agentToolListHandler,
  };
});

import { resolveHandler, invokeCapability } from "./index";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("handler registry", () => {
  it("resolveHandler returns a function for a registered capability", async () => {
    const fn = await resolveHandler("list_agent_tools");
    expect(typeof fn).toBe("function");
  });

  it("resolveHandler throws for an unknown capability", async () => {
    await expect(resolveHandler("does.not.exist")).rejects.toThrow(
      /No handler registered/,
    );
  });

  it("invokeCapability dispatches through the resolved handler", async () => {
    const res = await invokeCapability(
      "list_agent_tools",
      { includeExternal: false },
      CTX,
    );
    expect(res).toEqual({ tools: [] });
  });

  // ADR-022 snake_case capability names don't camelize to their module's
  // readable export via the dot-segment derivation ("agent.sandbox_file.list"
  // derives "agentSandbox_fileListHandler" but the module exports
  // "agentSandboxFilesListHandler"). resolveHandler must fall back to the
  // module's unique `*Handler` export — regression coverage for the fix.
  it.each([
    "list_sandbox_files",
    "read_sandbox_file",
    "start_background_task",
    "acquire_file_lock",
    "resolve_mcp_consent",
  ])(
    "resolves a handler function for snake_case capability %s",
    async (cap) => {
      const fn = await resolveHandler(cap);
      expect(typeof fn).toBe("function");
    },
    30_000,
  );

  // Exercise every agent-lifecycle loader so the lazy import() arrows are
  // covered and each handler module's expected export name is verified.
  it.each([
    "create_agent_def",
    "update_agent_def",
    "publish_agent_def",
    "get_agent_def",
    "list_agent_defs",
    "deploy_agent",
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
