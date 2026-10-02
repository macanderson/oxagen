// tool-steering-migrate.handlers.test.ts: the MCP tool for
// migrate_tools_to_steering (ADR-245, #4948).
//
// The kernel `invoke` and the context seam `buildContext` are doubles. Each
// case checks that invoke received the contract name, an empty input, and
// { surface: "mcp" }, and that the output passed the contract's output schema
// on the way back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import migrateToolsToSteering, { metadata, schema } from "./tool.steering.migrate";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: "usr_test",
  apiKeyId: null,
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const PR = { number: 12, url: "https://github.com/acme/oxagen-support/pull/12" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_session" });
});

describe("migrate_tools_to_steering", () => {
  it("carries the contract's name and says a repeat opens nothing new", () => {
    expect(metadata.name).toBe("migrate_tools_to_steering");
    expect(metadata.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("takes no arguments", () => {
    expect(Object.keys(schema)).toEqual([]);
  });

  it.each([
    { state: "opened", pullRequest: PR, pullRequests: [PR] },
    { state: "already_open", pullRequest: PR, pullRequests: [PR] },
    { state: "already_migrated", pullRequest: null, pullRequests: [] },
  ])("invokes with the contract name and forwards $state", async (output) => {
    mocks.invoke.mockResolvedValue(output);

    await expect(migrateToolsToSteering({})).resolves.toEqual(output);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("migrate_tools_to_steering", {}, fakeCtx, {
      surface: "mcp",
    });
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ state: "merged", pullRequest: PR, pullRequests: [PR] });
    await expect(migrateToolsToSteering({})).rejects.toThrow();
  });

  it("passes the kernel's refusal through", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("This workspace has no steering repo yet."), {
        code: "not_found",
        reason: "steering_repo_not_ready",
      }),
    );
    await expect(migrateToolsToSteering({})).rejects.toMatchObject({
      reason: "steering_repo_not_ready",
    });
  });
});
