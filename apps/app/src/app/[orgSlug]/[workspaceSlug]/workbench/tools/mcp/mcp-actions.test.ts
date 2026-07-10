/**
 * mcp-actions.test.ts — unit tests for connectCustomMcpServer and
 * revokeMcpCredential.
 *
 * Mock seams: ./authz (the agent-tools authorization choke point — see its
 * own docblock) and @oxagen/oxagen's invoke. Covers input validation, the
 * auth-denial pass-through, the success path (install_plugin /
 * revoke_plugin_credential called with the right shape, revalidatePath
 * fired), and the catch-path error message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/agent-tools/authz", () => ({
  resolveAgentToolsManager: vi.fn(),
}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    marketplace: {
      mcp: ({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) =>
        `/${orgSlug}/${workspaceSlug}/marketplace/mcp`,
    },
    workbench: {
      tools: {
        mcp: ({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) =>
          `/${orgSlug}/${workspaceSlug}/workbench/tools/mcp`,
      },
    },
  },
}));

import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import { resolveAgentToolsManager } from "@/lib/agent-tools/authz";
import { connectCustomMcpServer, revokeMcpCredential } from "./mcp-actions";
import type { ResolvedWorkbenchScope } from "@/lib/workbench/scope";

const mockInvoke = vi.mocked(invoke);
const mockResolveManager = vi.mocked(resolveAgentToolsManager);
const mockRevalidatePath = vi.mocked(revalidatePath);

const VALID_INPUT = {
  orgSlug: "acme",
  workspaceSlug: "main",
  name: "Custom Server",
  endpointUrl: "https://mcp.example.com/sse",
  transport: "streamable-http" as const,
  authKind: "none" as const,
};

const AUTHORIZED_SCOPE = {
  org: { id: "org-1" },
  ws: { id: "ws-1" },
  ctx: { orgId: "org-1", workspaceId: "ws-1" },
} as unknown as ResolvedWorkbenchScope;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connectCustomMcpServer", () => {
  it("returns ok:false on invalid input without resolving auth", async () => {
    const result = await connectCustomMcpServer({ ...VALID_INPUT, endpointUrl: "not-a-url" });

    expect(result).toEqual({ ok: false, error: "Invalid input" });
    expect(mockResolveManager).not.toHaveBeenCalled();
  });

  it("passes through the auth-denial error", async () => {
    mockResolveManager.mockResolvedValue({ ok: false, error: "Only workspace owners and admins can manage agent tools." });

    const result = await connectCustomMcpServer(VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      error: "Only workspace owners and admins can manage agent tools.",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("installs the custom mcp_server plugin and revalidates the marketplace path on success", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockResolvedValue({ orgListingId: "orl_1", authKind: "none" });

    const result = await connectCustomMcpServer(VALID_INPUT);

    expect(mockInvoke).toHaveBeenCalledWith(
      "install_plugin",
      {
        pluginType: "mcp_server",
        custom: {
          name: "Custom Server",
          endpointUrl: "https://mcp.example.com/sse",
          transport: "streamable-http",
          authKind: "none",
        },
      },
      AUTHORIZED_SCOPE.ctx,
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/marketplace/mcp");
    expect(result).toEqual({ ok: true, orgListingId: "orl_1", authKind: "none" });
  });

  it("returns a clean error when install_plugin rejects", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockRejectedValue(new Error("endpoint unreachable"));

    const result = await connectCustomMcpServer(VALID_INPUT);

    expect(result).toEqual({ ok: false, error: "endpoint unreachable" });
  });

  it("falls back to a generic message when the thrown value isn't an Error", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockRejectedValue("weird throw");

    const result = await connectCustomMcpServer(VALID_INPUT);

    expect(result).toEqual({ ok: false, error: "Connect failed" });
  });
});

const VALID_REVOKE_INPUT = {
  orgSlug: "acme",
  workspaceSlug: "main",
  orgListingId: "orl_1",
};

describe("revokeMcpCredential", () => {
  it("returns ok:false on invalid input without resolving auth", async () => {
    const result = await revokeMcpCredential({ ...VALID_REVOKE_INPUT, orgListingId: "" });

    expect(result).toEqual({ ok: false, error: "Invalid input" });
    expect(mockResolveManager).not.toHaveBeenCalled();
  });

  it("passes through the auth-denial error", async () => {
    mockResolveManager.mockResolvedValue({ ok: false, error: "Only workspace owners and admins can manage agent tools." });

    const result = await revokeMcpCredential(VALID_REVOKE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: "Only workspace owners and admins can manage agent tools.",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("revokes the credential and revalidates the workbench tools mcp path on success", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockResolvedValue({ revoked: true });

    const result = await revokeMcpCredential(VALID_REVOKE_INPUT);

    expect(mockInvoke).toHaveBeenCalledWith(
      "revoke_plugin_credential",
      { orgListingId: "orl_1" },
      AUTHORIZED_SCOPE.ctx,
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/workbench/tools/mcp");
    expect(result).toEqual({ ok: true, revoked: true });
  });

  it("reports revoked:false when no credential existed", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockResolvedValue({ revoked: false });

    const result = await revokeMcpCredential(VALID_REVOKE_INPUT);

    expect(result).toEqual({ ok: true, revoked: false });
  });

  it("returns a clean error when revoke_plugin_credential rejects", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockRejectedValue(new Error("Installed plugin not found or deleted: orl_1"));

    const result = await revokeMcpCredential(VALID_REVOKE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: "Installed plugin not found or deleted: orl_1",
    });
  });

  it("falls back to a generic message when the thrown value isn't an Error", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockRejectedValue("weird throw");

    const result = await revokeMcpCredential(VALID_REVOKE_INPUT);

    expect(result).toEqual({ ok: false, error: "Revoke failed" });
  });
});
