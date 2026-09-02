/**
 * sandbox-template-actions.test.ts — unit tests for the sandbox-template server actions.
 *
 * Covers, for the sandbox.template.* capability family:
 *   - reads (list) invoke the right capability with surface:"agent"
 *   - create/update/setDefault/delete/setTools happy paths → ok:true,
 *     revalidatePath called, invoke called with the real contract .name
 *   - the Owner/Admin role gate: a member/viewer → ok:false and invoke NOT called
 *   - invoke throwing → ok:false with the propagated message
 *   - export is a member-allowed read (no manager gate) and returns the manifest
 *   - import passes through the handler warnings[]
 *   - readToolSourcesAction flattens the equip pools into kind+ref options
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
  mockBuildWorkbenchCtx,
  mockLoadEquipSources,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    wsRoleRows: Array<{ role: string }>;
  }
  const dbState: DbState = { wsRoleRows: [{ role: "owner" }] };

  const mockLimit = vi.fn(() => Promise.resolve(dbState.wsRoleRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockResolveWorkspace: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockInvoke: vi.fn(),
    mockRevalidatePath: vi.fn(),
    mockBuildWorkbenchCtx: vi.fn(() => ({ surface: "app" })),
    mockLoadEquipSources: vi.fn(),
    dbState,
  };
});

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mockWithTenantDb };
});
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/workbench/scope", () => ({
  buildWorkbenchCtx: mockBuildWorkbenchCtx,
}));
vi.mock("@/lib/workbench/equip-sources", () => ({
  loadEquipSources: mockLoadEquipSources,
}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    workbench: {
      sandboxes: ({
        orgSlug,
        workspaceSlug,
      }: {
        orgSlug: string;
        workspaceSlug: string;
      }) => `/${orgSlug}/${workspaceSlug}/workbench/sandboxes`,
    },
  },
}));

import {
  readTemplatesAction,
  readToolSourcesAction,
  createTemplateAction,
  updateTemplateAction,
  setTemplateToolsAction,
  setDefaultTemplateAction,
  deleteTemplateAction,
  exportTemplateAction,
  importTemplateAction,
} from "./sandbox-template-actions";

const SCOPE = { orgSlug: "acme", workspaceSlug: "default" };

const TEMPLATE = {
  id: "tpl_1",
  environmentId: "env_1",
  name: "Base",
  slug: "base",
  description: null,
  isDefault: false,
  isActive: true,
  provider: "modal",
  runtime: null,
  resources: {},
  network: { mode: "public" },
  secretSelection: "all",
  literalEnv: {},
  tools: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbState.wsRoleRows = [{ role: "owner" }];
  mockGetSession.mockResolvedValue({ user: { id: "user_1" } });
  mockResolveOrg.mockResolvedValue({ id: "org_1" });
  mockResolveWorkspace.mockResolvedValue({ id: "ws_1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
});

describe("readTemplatesAction", () => {
  it("invokes list_sandbox_templates with surface agent and returns templates", async () => {
    mockInvoke.mockResolvedValue({ templates: [TEMPLATE] });
    const out = await readTemplatesAction(SCOPE);
    expect(out).toEqual([TEMPLATE]);
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_sandbox_templates",
      {},
      expect.objectContaining({ orgId: "org_1", workspaceId: "ws_1" }),
      { surface: "agent" },
    );
  });
});

describe("createTemplateAction", () => {
  it("owner: invokes create_sandbox_template, returns template, revalidates", async () => {
    mockInvoke.mockResolvedValue({ template: TEMPLATE });
    const res = await createTemplateAction({
      ...SCOPE,
      environmentId: "env_1",
      name: "Base",
      slug: "base",
    });
    expect(res).toEqual({ ok: true, template: TEMPLATE });
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_sandbox_template",
      expect.objectContaining({
        environmentId: "env_1",
        name: "Base",
        slug: "base",
      }),
      expect.any(Object),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/default/workbench/sandboxes",
    );
  });

  it("member: role gate rejects, invoke NOT called", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await createTemplateAction({
      ...SCOPE,
      environmentId: "env_1",
      name: "Base",
      slug: "base",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invoke throws → ok:false with message", async () => {
    mockInvoke.mockRejectedValue(new Error("boom"));
    const res = await createTemplateAction({
      ...SCOPE,
      environmentId: "env_1",
      name: "Base",
      slug: "base",
    });
    expect(res).toEqual({ ok: false, error: "boom" });
  });
});

describe("updateTemplateAction", () => {
  it("owner: invokes update_sandbox_template", async () => {
    mockInvoke.mockResolvedValue({ template: TEMPLATE });
    const res = await updateTemplateAction({
      ...SCOPE,
      templateId: "tpl_1",
      name: "New",
    });
    expect(res).toEqual({ ok: true, template: TEMPLATE });
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_sandbox_template",
      expect.objectContaining({ templateId: "tpl_1", name: "New" }),
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("setTemplateToolsAction", () => {
  it("owner: invokes set_sandbox_template_tools", async () => {
    mockInvoke.mockResolvedValue({ template: TEMPLATE });
    const res = await setTemplateToolsAction({
      ...SCOPE,
      templateId: "tpl_1",
      tools: [{ kind: "capability", ref: "list_environments" }],
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "set_sandbox_template_tools",
      {
        templateId: "tpl_1",
        tools: [{ kind: "capability", ref: "list_environments" }],
      },
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("setDefaultTemplateAction", () => {
  it("owner: invokes set_default_sandbox_template", async () => {
    mockInvoke.mockResolvedValue({
      template: { ...TEMPLATE, isDefault: true },
    });
    const res = await setDefaultTemplateAction({
      ...SCOPE,
      templateId: "tpl_1",
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "set_default_sandbox_template",
      { templateId: "tpl_1" },
      expect.any(Object),
      { surface: "agent" },
    );
  });

  it("member: role gate rejects", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await setDefaultTemplateAction({
      ...SCOPE,
      templateId: "tpl_1",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("deleteTemplateAction", () => {
  it("owner: invokes delete_sandbox_template", async () => {
    mockInvoke.mockResolvedValue({ ok: true });
    const res = await deleteTemplateAction({ ...SCOPE, templateId: "tpl_1" });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "delete_sandbox_template",
      { templateId: "tpl_1" },
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("exportTemplateAction", () => {
  it("member-allowed read (no manager gate): returns manifest", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const manifest = {
      kind: "oxagen.sandbox-template",
      version: 1,
      name: "Base",
      slug: "base",
    };
    mockInvoke.mockResolvedValue({ manifest });
    const res = await exportTemplateAction({ ...SCOPE, templateId: "tpl_1" });
    expect(res).toEqual({ ok: true, manifest });
    expect(mockInvoke).toHaveBeenCalledWith(
      "export_sandbox_template",
      { templateId: "tpl_1" },
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("importTemplateAction", () => {
  it("owner: invokes import_sandbox_template and passes through warnings", async () => {
    const manifest = {
      kind: "oxagen.sandbox-template",
      version: 1,
      name: "Base",
      slug: "base",
    };
    mockInvoke.mockResolvedValue({
      template: TEMPLATE,
      warnings: ["tool xyz not installed"],
    });
    const res = await importTemplateAction({
      ...SCOPE,
      environmentId: "env_1",
      manifest: manifest as never,
      slug: "base-copy",
      setAsDefault: false,
    });
    expect(res).toEqual({
      ok: true,
      template: TEMPLATE,
      warnings: ["tool xyz not installed"],
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "import_sandbox_template",
      expect.objectContaining({ environmentId: "env_1", slug: "base-copy" }),
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("readToolSourcesAction", () => {
  it("flattens skills, capabilities, and mcp servers into kind+ref options", async () => {
    mockLoadEquipSources.mockResolvedValue({
      skills: [
        { ref: "sk_1", name: "Summarize", description: "", enabled: true },
      ],
      tools: [
        {
          name: "list_environments",
          description: "",
          domain: "environment",
          category: null,
          riskLevel: "low",
          requiresApproval: false,
          external: false,
        },
      ],
      subagents: [{ ref: "ag_1", name: "Helper", slug: "helper" }],
      mcp: [
        {
          ref: "mcp_1",
          name: "gh",
          title: "GitHub",
          description: null,
          enabled: true,
        },
      ],
    });
    const out = await readToolSourcesAction(SCOPE);
    expect(out).toEqual([
      { kind: "agent_skill", ref: "sk_1", label: "Summarize" },
      {
        kind: "capability",
        ref: "list_environments",
        label: "list_environments",
      },
      { kind: "mcp_server", ref: "mcp_1", label: "GitHub" },
    ]);
  });

  it("degrades to [] when equip-source load throws", async () => {
    mockLoadEquipSources.mockRejectedValue(new Error("cold"));
    const out = await readToolSourcesAction(SCOPE);
    expect(out).toEqual([]);
  });
});
