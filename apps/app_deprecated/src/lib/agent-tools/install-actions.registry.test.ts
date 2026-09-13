/**
 * install-actions.registry.test.ts — unit tests for addRegistry / removeRegistry.
 *
 * Mock seams: ./authz (the agent-tools authorization choke point) and
 * @oxagen/oxagen's invoke — mirrors mcp-actions.test.ts's approach rather than
 * install-actions.installBulk.test.ts's full session/db chain, since these two
 * actions don't touch the database directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: vi.fn() }));
vi.mock("./authz", () => ({
  resolveAgentToolsManager: vi.fn(),
}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    workbench: {
      tools: {
        capabilities: ({
          orgSlug,
          workspaceSlug,
        }: {
          orgSlug: string;
          workspaceSlug: string;
        }) => `/${orgSlug}/${workspaceSlug}/workbench/tools/capabilities`,
      },
    },
  },
}));

import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import { resolveAgentToolsManager } from "./authz";
import { addRegistry, removeRegistry } from "./install-actions";
import type { ResolvedWorkbenchScope } from "@/lib/workbench/scope";

const mockInvoke = vi.mocked(invoke);
const mockResolveManager = vi.mocked(resolveAgentToolsManager);
const mockRevalidatePath = vi.mocked(revalidatePath);

const AUTHORIZED_SCOPE = {
  org: { id: "org-1" },
  ws: { id: "ws-1" },
  ctx: { orgId: "org-1", workspaceId: "ws-1" },
} as unknown as ResolvedWorkbenchScope;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addRegistry", () => {
  it("returns ok:false on invalid input", async () => {
    const result = await addRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      name: "",
      baseUrl: "",
    });
    expect(result).toEqual({ ok: false, error: "Invalid input" });
    expect(mockResolveManager).not.toHaveBeenCalled();
  });

  it("passes through the auth-denial error", async () => {
    mockResolveManager.mockResolvedValue({ ok: false, error: "denied" });

    const result = await addRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      name: "Custom Registry",
      baseUrl: "https://registry.example.com",
    });

    expect(result).toEqual({ ok: false, error: "denied" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("adds the registry and revalidates the capabilities path on success", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockResolvedValue({ registryId: "reg_1", isDefault: false });

    const result = await addRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      name: "Custom Registry",
      baseUrl: "https://registry.example.com",
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "add_plugin_registry",
      { name: "Custom Registry", baseUrl: "https://registry.example.com" },
      AUTHORIZED_SCOPE.ctx,
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/workbench/tools/capabilities",
    );
    expect(result).toEqual({ ok: true, registryId: "reg_1", isDefault: false });
  });

  it("returns a clean error when add_plugin_registry rejects", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockRejectedValue(new Error("registry unreachable"));

    const result = await addRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      name: "Custom Registry",
      baseUrl: "https://registry.example.com",
    });

    expect(result).toEqual({ ok: false, error: "registry unreachable" });
  });
});

describe("removeRegistry", () => {
  it("returns ok:false on invalid input", async () => {
    const result = await removeRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      registryId: "",
    });
    expect(result).toEqual({ ok: false, error: "Invalid input" });
  });

  it("passes through the auth-denial error", async () => {
    mockResolveManager.mockResolvedValue({ ok: false, error: "denied" });

    const result = await removeRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      registryId: "reg_1",
    });

    expect(result).toEqual({ ok: false, error: "denied" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("removes the registry and returns the promoted default id", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockResolvedValue({ ok: true, promotedId: "reg_2" });

    const result = await removeRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      registryId: "reg_1",
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "remove_plugin_registry",
      { registryId: "reg_1" },
      AUTHORIZED_SCOPE.ctx,
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/workbench/tools/capabilities",
    );
    expect(result).toEqual({ ok: true, promotedId: "reg_2" });
  });

  it("returns a clean error when remove_plugin_registry rejects", async () => {
    mockResolveManager.mockResolvedValue({ ok: true, scope: AUTHORIZED_SCOPE });
    mockInvoke.mockRejectedValue(new Error("still in use"));

    const result = await removeRegistry({
      orgSlug: "acme",
      workspaceSlug: "main",
      registryId: "reg_1",
    });

    expect(result).toEqual({ ok: false, error: "still in use" });
  });
});
