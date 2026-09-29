// The `revoke_relay` MCP tool (M12, #4685): it names the contract, marks itself
// destructive and not idempotent, builds the context once, invokes the
// capability on the mcp surface with the name alone, and parses the answer.
// A missing or unroutable name, or an argument that names a workspace, is
// refused before the kernel runs. No create_relay tool exists beside it,
// because its answer would put a plaintext relay token in the transcript.
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext`.
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import revokeRelayTool, { metadata, schema } from "./tool.relay.revoke";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const REVOKED = {
  publicId: "rly_0123456789abcdefghjkmn",
  name: "office-lan",
  revokedAt: "2026-09-28T18:05:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("revoke_relay MCP tool", () => {
  it("names the contract and marks the call destructive and not idempotent", () => {
    expect(metadata.name).toBe("revoke_relay");
    expect(metadata.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(Object.keys(schema)).toEqual(["name"]);
  });

  it("tells the agent when the revoke takes hold", () => {
    expect(metadata.description).toContain("next connect");
    expect(metadata.description).toContain("30 seconds");
  });

  it("invokes revoke_relay on the mcp surface with the name and returns the revoked relay", async () => {
    mocks.invoke.mockResolvedValue(REVOKED);
    const out = await revokeRelayTool({ name: "office-lan" });
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "revoke_relay",
      { name: "office-lan" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(out).toEqual(REVOKED);
  });

  it("refuses a call with no name before the kernel runs (negative)", async () => {
    await expect(revokeRelayTool({} as { name: string })).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses a name the broker cannot route before the kernel runs (negative)", async () => {
    await expect(revokeRelayTool({ name: "Office_LAN" })).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses an argument that names a workspace, since the scope is the caller's (negative)", async () => {
    await expect(
      revokeRelayTool({
        name: "office-lan",
        workspaceId: "other",
      } as { name: string }),
    ).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("propagates a refusal from the kernel (negative)", async () => {
    mocks.invoke.mockRejectedValue(new Error("relay_not_found"));
    await expect(revokeRelayTool({ name: "office-lan" })).rejects.toThrow(
      "relay_not_found",
    );
  });

  it("has no create_relay tool beside it, so no relay token reaches a transcript", () => {
    expect(existsSync(new URL("./tool.relay.create.ts", import.meta.url))).toBe(
      false,
    );
  });
});
