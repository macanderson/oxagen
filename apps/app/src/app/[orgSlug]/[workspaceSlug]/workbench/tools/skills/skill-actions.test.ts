/**
 * skill-actions.test.ts — unit tests for workspace skills server actions.
 *
 * Covers:
 *   installSkill:
 *     - validation: empty orgSlug / empty skillSlug → ok:false
 *     - role gate: viewer role → ok:false, NOT_AUTHORIZED
 *     - happy path: invoke("skill.workspace.install") called, revalidatePath, ok:true
 *     - invoke throws → ok:false with mapped error
 *
 *   editSkill:
 *     - validation: empty content → ok:false
 *     - role gate: viewer → ok:false
 *     - happy path: invoke("skill.version.upload") called, returns versionId+version
 *     - invoke throws → ok:false
 *
 *   activateVersion:
 *     - validation: empty versionId → ok:false
 *     - role gate: viewer → ok:false
 *     - happy path: invoke("skill.version.activate") called, revalidatePath, ok:true
 *     - invoke throws → ok:false
 *
 *   exportSkill:
 *     - validation: empty skillSlug → ok:false
 *     - read allowed for all workspace members (no canManage check)
 *     - happy path: invoke("skill.export") called, returns content+filename
 *     - invoke throws → ok:false
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database (withTenantDb),
 *   @oxagen/tenancy, @oxagen/oxagen (invoke), @oxagen/handlers/register, next/cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
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
    dbState,
  };
});

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
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

// Mock the routes module for the workspace.workbench.tools.* path builders the
// actions revalidate.
vi.mock("@/lib/routes", () => ({
  workspace: {
    workbench: {
      tools: {
        skills: ({
          orgSlug,
          workspaceSlug,
        }: {
          orgSlug: string;
          workspaceSlug: string;
        }) => `/${orgSlug}/${workspaceSlug}/workbench/tools/skills`,
        skill: (
          {
            orgSlug,
            workspaceSlug,
          }: { orgSlug: string; workspaceSlug: string },
          skillSlug: string,
        ) =>
          `/${orgSlug}/${workspaceSlug}/workbench/tools/skills/${encodeURIComponent(skillSlug)}`,
      },
    },
  },
}));

import {
  installSkill,
  editSkill,
  activateVersion,
  exportSkill,
} from "./skill-actions";

// ---------------------------------------------------------------------------
// Shared defaults
// ---------------------------------------------------------------------------

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "research" };

function setup({ wsRole = "owner" }: { wsRole?: string } = {}) {
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WS);
  mockAssertOrgMember.mockResolvedValue(undefined);
  dbState.wsRoleRows = [{ role: wsRole }];
}

function baseInstall(overrides: Record<string, string> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "research",
    skillSlug: "summarizer",
    ...overrides,
  };
}

function baseEdit(overrides: Record<string, string> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "research",
    skillSlug: "summarizer",
    content: "You are a summarizer.",
    ...overrides,
  };
}

function baseActivate(overrides: Record<string, string | number> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "research",
    skillSlug: "summarizer",
    versionNumber: 2,
    ...overrides,
  };
}

function baseExport(overrides: Record<string, string> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "research",
    skillSlug: "summarizer",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// installSkill
// ---------------------------------------------------------------------------

describe("installSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("returns ok:false for empty orgSlug", async () => {
    const result = await installSkill({
      orgSlug: "",
      workspaceSlug: "research",
      skillSlug: "summarizer",
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false for empty skillSlug", async () => {
    const result = await installSkill({
      orgSlug: "acme",
      workspaceSlug: "research",
      skillSlug: "",
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false with NOT_AUTHORIZED for a viewer workspace role", async () => {
    setup({ wsRole: "member" });
    const result = await installSkill(baseInstall());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only workspace owners and admins/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("calls invoke with skill.workspace.install and revalidates path on success", async () => {
    mockInvoke.mockResolvedValue({});

    const result = await installSkill(baseInstall());

    expect(result.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledOnce();
    // Contract: skill.workspace.install takes the builtin template `slug`.
    const [capability, payload] = mockInvoke.mock.calls[0] as [
      string,
      { slug: string },
    ];
    expect(capability).toBe("install_skill");
    expect(payload.slug).toBe("summarizer");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research/workbench/tools/skills",
    );
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Permission denied"));

    const result = await installSkill(baseInstall());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Permission denied");
  });

  it("accepts admin workspace role", async () => {
    setup({ wsRole: "admin" });
    mockInvoke.mockResolvedValue({});

    const result = await installSkill(baseInstall());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// editSkill
// ---------------------------------------------------------------------------

describe("editSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("returns ok:false for empty content", async () => {
    const result = await editSkill({ ...baseEdit(), content: "" });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false for empty skillSlug", async () => {
    const result = await editSkill({ ...baseEdit(), skillSlug: "" });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false with NOT_AUTHORIZED for viewer role", async () => {
    setup({ wsRole: "viewer" });
    const result = await editSkill(baseEdit());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only workspace owners and admins/i);
  });

  it("calls invoke with skill.version.upload as a draft and returns version info", async () => {
    mockInvoke.mockResolvedValue({
      version_id: "slv_123",
      version_number: 2,
      skill_id: "skl_1",
      activated: false,
    });

    const result = await editSkill({
      ...baseEdit(),
      commitMessage: "Added detail",
    });

    expect(result.ok).toBe(true);
    expect(result.versionId).toBe("slv_123");
    expect(result.version).toBe("v2");
    expect(result.versionNumber).toBe(2);
    expect(mockInvoke).toHaveBeenCalledOnce();

    // Contract shapes: skill_id (slug accepted), content, change_summary — and
    // activate:false so the edit is a draft until the user confirms the pin.
    const [capability, payload] = mockInvoke.mock.calls[0] as [
      string,
      {
        skill_id: string;
        content: string;
        change_summary?: string;
        activate: boolean;
      },
    ];
    expect(capability).toBe("upload_skill_version");
    expect(payload.skill_id).toBe("summarizer");
    expect(payload.content).toBe("You are a summarizer.");
    expect(payload.change_summary).toBe("Added detail");
    expect(payload.activate).toBe(false);
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research/workbench/tools/skills",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research/workbench/tools/skills/summarizer",
    );
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Upload failed"));

    const result = await editSkill(baseEdit());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Upload failed");
  });
});

// ---------------------------------------------------------------------------
// activateVersion
// ---------------------------------------------------------------------------

describe("activateVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("returns ok:false for a non-positive versionNumber", async () => {
    const result = await activateVersion({
      ...baseActivate(),
      versionNumber: 0,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false with NOT_AUTHORIZED for viewer role", async () => {
    setup({ wsRole: "viewer" });
    const result = await activateVersion(baseActivate());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only workspace owners and admins/i);
  });

  it("calls invoke with skill.version.activate and revalidates path", async () => {
    mockInvoke.mockResolvedValue({});

    const result = await activateVersion(baseActivate());

    expect(result.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledOnce();

    // Contract shapes: skillId (slug accepted) + integer versionNumber.
    const [capability, payload] = mockInvoke.mock.calls[0] as [
      string,
      { skillId: string; versionNumber: number },
    ];
    expect(capability).toBe("activate_skill_version");
    expect(payload.skillId).toBe("summarizer");
    expect(payload.versionNumber).toBe(2);
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research/workbench/tools/skills",
    );
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Activate failed"));

    const result = await activateVersion(baseActivate());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Activate failed");
  });
});

// ---------------------------------------------------------------------------
// exportSkill
// ---------------------------------------------------------------------------

describe("exportSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("returns ok:false for empty skillSlug", async () => {
    const result = await exportSkill({
      orgSlug: "acme",
      workspaceSlug: "research",
      skillSlug: "",
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("allows export for a viewer workspace role (no manage check)", async () => {
    setup({ wsRole: "viewer" });
    mockInvoke.mockResolvedValue({
      content: "# Skill content",
      filename: "summarizer.md",
    });

    // viewer should NOT be blocked on export (read is open to all workspace members)
    const result = await exportSkill(baseExport());
    expect(result.ok).toBe(true);
  });

  it("calls invoke with skill.export and returns content + filename", async () => {
    mockInvoke.mockResolvedValue({
      content: "# My skill",
      filename: "summarizer.md",
    });

    const result = await exportSkill(baseExport());

    expect(result.ok).toBe(true);
    expect(result.content).toBe("# My skill");
    expect(result.filename).toBe("summarizer.md");

    // Contract shapes: skillId (slug accepted) + optional integer versionNumber.
    const [capability, payload] = mockInvoke.mock.calls[0] as [
      string,
      { skillId: string; versionNumber?: number },
    ];
    expect(capability).toBe("export_skill");
    expect(payload.skillId).toBe("summarizer");
  });

  it("passes versionNumber through when provided", async () => {
    mockInvoke.mockResolvedValue({
      content: "v1 content",
      filename: "summarizer-v1.md",
    });

    await exportSkill({ ...baseExport(), versionNumber: 1 });

    const [, payload] = mockInvoke.mock.calls[0] as [
      string,
      { versionNumber?: number },
    ];
    expect(payload.versionNumber).toBe(1);
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Export failed"));

    const result = await exportSkill(baseExport());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Export failed");
  });
});
