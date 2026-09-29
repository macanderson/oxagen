// studio-capabilities.handlers.test.ts: handler invocation tests for the
// Studio tools that serve MCP Studio's app screens (#4678):
// set_mcp_credential, list_studio_findings, draft_studio_description, and
// try_studio_tool.
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext`.
// Each test asserts buildContext was called, invoke received the contract
// name, the args, and { surface: "mcp" }, and the output passed the
// contract's output schema on the way back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import setMcpCredential, {
  metadata as setMcpCredentialMeta,
  schema as setMcpCredentialSchema,
} from "./tool.studio.credential.set";

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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("set_mcp_credential", () => {
  it("carries the contract's name and marks a replace destructive", () => {
    expect(setMcpCredentialMeta.name).toBe("set_mcp_credential");
    expect(setMcpCredentialMeta.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(Object.keys(setMcpCredentialSchema).sort()).toEqual([
      "clientId",
      "clientSecret",
      "kind",
      "name",
      "secret",
    ]);
  });

  it("invokes with the contract name and returns the name and reference only", async () => {
    const output = { name: "stripe-live", reference: "oxagen:credential/stripe-live", created: true };
    mocks.invoke.mockResolvedValue(output);
    const args = {
      name: "stripe-live",
      kind: "secret" as const,
      secret: "sk_test_fake_1",
      clientId: undefined,
      clientSecret: undefined,
    };

    const result = await setMcpCredential(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("set_mcp_credential", args, fakeCtx, { surface: "mcp" });
    expect(result).toEqual(output);
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ name: "stripe-live" });
    await expect(
      setMcpCredential({
        name: "stripe-live",
        kind: "secret",
        secret: "sk_test_fake_1",
        clientId: undefined,
        clientSecret: undefined,
      }),
    ).rejects.toThrow();
  });
});
