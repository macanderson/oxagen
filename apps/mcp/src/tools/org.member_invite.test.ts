import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));
import resend, { metadata as resendMetadata } from "./org.member_invite.resend";
import revoke, { metadata as revokeMetadata } from "./org.member_invite.revoke";
const ctx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: "user_test",
  surface: "mcp",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(ctx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test" });
});
describe.each([
  ["resend_member_invite", resend, resendMetadata, "pending"],
  ["revoke_member_invite", revoke, revokeMetadata, "revoked"],
] as const)("%s MCP adapter", (name, tool, metadata, status) => {
  const args = { invitationPublicId: "invi_test" };
  it("dispatches through the authenticated kernel context", async () => {
    const output = { ...args, status, expiresAt: null };
    mocks.invoke.mockResolvedValue(output);
    expect(await tool(args)).toEqual(output);
    expect(metadata.name).toBe(name);
    expect(metadata.annotations?.readOnlyHint).toBe(false);
    expect(mocks.buildContext).toHaveBeenCalledWith({
      authorization: "Bearer test",
    });
    expect(mocks.invoke).toHaveBeenCalledWith(name, args, ctx, {
      surface: "mcp",
    });
  });
  it("refuses malformed results", async () => {
    mocks.invoke.mockResolvedValue({ status });
    await expect(tool(args)).rejects.toThrow();
  });
  it("propagates authorization failure before invoking", async () => {
    mocks.buildContext.mockRejectedValue(new Error("denied"));
    await expect(tool(args)).rejects.toThrow("denied");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
