/**
 * tools.test.ts — unit tests for the workbench/tools.ts kernel wrapper.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@oxagen/oxagen";
import { listAgentTools } from "./tools";
import type { WorkbenchCtx } from "./scope";

const mockInvoke = vi.mocked(invoke);

const ctx: WorkbenchCtx = {
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
});

describe("listAgentTools", () => {
  it("defaults includeExternal to true and unwraps { tools }", async () => {
    const tools = [{ name: "get_pr" }];
    mockInvoke.mockResolvedValue({ tools });

    const result = await listAgentTools(ctx);

    expect(mockInvoke).toHaveBeenCalledWith(
      "list_agent_tools",
      { includeExternal: true },
      ctx,
      { surface: "agent" },
    );
    expect(result).toBe(tools);
  });

  it("passes includeExternal: false through when explicitly opted out", async () => {
    mockInvoke.mockResolvedValue({ tools: [] });

    await listAgentTools(ctx, false);

    expect(mockInvoke).toHaveBeenCalledWith(
      "list_agent_tools",
      { includeExternal: false },
      ctx,
      { surface: "agent" },
    );
  });
});
