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
  const mockWithTenantDb = vi.fn(
    (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn(
    (_scope: unknown, fn: () => unknown) => fn(),
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

// Mock the routes module for the workspace.studio.tools.* path builders the
// actions revalidate.
vi.mock("@/lib/routes", () => ({
  workspace: {
    studio: {
      tools: {
        skills: ({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) =>
          `/${orgSlug}/${workspaceSlug}/studio/tools/skills`,
        skill: (
          { orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string },
          skillSlug: string,
        ) => `/${orgSlug}/${workspaceSlug}/studio/tools/skills/${encodeURIComponent(skillSlug)}`,
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
  return { orgSlug: "acme", workspaceSlug: "research", skillSlug: "summarizer", ...overrides };
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

function baseActivate(overrides: Record<string, string> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "research",
    skillSlug: "summarizer",
    versionId: "ver_abc123",
    ...overrides,
  };
}

function baseExport(overrides: Record<string, string> = {}) {
  return { orgSlug: "acme", workspaceSlug: "research", skillSlug: "summarizer", ...overrides };
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
    const result = await installSkill({ orgSlug: "", workspaceSlug: "research", skillSlug: "summarizer" });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false for empty skillSlug", async () => {
    const result = await installSkill({ orgSlug: "acme", workspaceSlug: "research", skillSlug: "" });
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
    const [capability, payload] = mockInvoke.mock.calls[0] as [string, { skillSlug: string }];
    expect(capability).toBe("skill.workspace.install");
    expect(payload.skillSlug).toBe("summarizer");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/research/studio/tools/skills");
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

  it("calls invoke with skill.version.upload and returns versionId + version", async () => {
    mockInvoke.mockResolvedValue({ versionId: "ver_123", version: "v2" });

    const result = await editSkill({ ...baseEdit(), commitMessage: "Added detail" });

    expect(result.ok).toBe(true);
    expect(result.versionId).toBe("ver_123");
    expect(result.version).toBe("v2");
    expect(mockInvoke).toHaveBeenCalledOnce();

    const [capability, payload] = mockInvoke.mock.calls[0] as [
      string,
      { skillSlug: string; content: string; commitMessage?: string },
    ];
    expect(capability).toBe("skill.version.upload");
    expect(payload.skillSlug).toBe("summarizer");
    expect(payload.content).toBe("You are a summarizer.");
    expect(payload.commitMessage).toBe("Added detail");
    expect(mockRevalidatePath).toHaveBeenCalled();
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

  it("returns ok:false for empty versionId", async () => {
    const result = await activateVersion({ ...baseActivate(), versionId: "" });
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

    const [capability, payload] = mockInvoke.mock.calls[0] as [
      string,
      { skillSlug: string; versionId: string },
    ];
    expect(capability).toBe("skill.version.activate");
    expect(payload.skillSlug).toBe("summarizer");
    expect(payload.versionId).toBe("ver_abc123");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/research/studio/tools/skills");
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
    const result = await exportSkill({ orgSlug: "acme", workspaceSlug: "research", skillSlug: "" });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("allows export for a viewer workspace role (no manage check)", async () => {
    setup({ wsRole: "viewer" });
    mockInvoke.mockResolvedValue({ content: "# Skill content", filename: "summarizer.md" });

    // viewer should NOT be blocked on export (read is open to all workspace members)
    const result = await exportSkill(baseExport());
    expect(result.ok).toBe(true);
  });

  it("calls invoke with skill.export and returns content + filename", async () => {
    mockInvoke.mockResolvedValue({ content: "# My skill", filename: "summarizer.md" });

    const result = await exportSkill(baseExport());

    expect(result.ok).toBe(true);
    expect(result.content).toBe("# My skill");
    expect(result.filename).toBe("summarizer.md");

    const [capability, payload] = mockInvoke.mock.calls[0] as [
      string,
      { skillSlug: string; versionId?: string },
    ];
    expect(capability).toBe("skill.export");
    expect(payload.skillSlug).toBe("summarizer");
  });

  it("passes versionId through when provided", async () => {
    mockInvoke.mockResolvedValue({ content: "v1 content", filename: "summarizer-v1.md" });

    await exportSkill({ ...baseExport(), versionId: "ver_v1" });

    const [, payload] = mockInvoke.mock.calls[0] as [string, { versionId?: string }];
    expect(payload.versionId).toBe("ver_v1");
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Export failed"));

    const result = await exportSkill(baseExport());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Export failed");
  });
});
