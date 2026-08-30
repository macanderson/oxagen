/**
 * actions.test.ts — unit tests for environment-vault server actions.
 *
 * Covers:
 *   importEnvAction:
 *     - preview path (commit:false) returns rows + committed:false
 *     - invoke called with "secret.import_env" + correct args + surface:"agent"
 *     - commit path (commit:true) returns committed:true + revalidatePath called
 *     - role gate: member/viewer → ok:false / "Only … owners or admins…", invoke NOT called
 *     - invoke throws → ok:false propagates the error message
 *   setDefaultEnvironmentAction:
 *     - happy path: ok:true, invoke called with "environment.set_default"
 *     - role gate: member → ok:false, invoke NOT called
 *   upsertKeyAction:
 *     - happy path: ok:true, invoke called with "secret.key.upsert"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures (vi.hoisted so they are available before vi.mock calls)
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
  // runInTenantScope immediately calls its callback — same as integration-actions tests
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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    workbench: {
      environments: ({
        orgSlug,
        workspaceSlug,
      }: {
        orgSlug: string;
        workspaceSlug: string;
      }) => `/${orgSlug}/${workspaceSlug}/workbench/environments`,
    },
  },
}));

import {
  importEnvAction,
  setDefaultEnvironmentAction,
  upsertKeyAction,
} from "./actions";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };

const PREVIEW_ROWS = [
  {
    key: "DATABASE_URL",
    isNewKey: true,
    sensitive: true,
    target: "default" as const,
    willOverride: false,
  },
  {
    key: "LOG_LEVEL",
    isNewKey: false,
    sensitive: false,
    target: "default" as const,
    willOverride: true,
  },
];

// ---------------------------------------------------------------------------
// importEnvAction
// ---------------------------------------------------------------------------

describe("importEnvAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("preview path: returns rows and committed:false, calls secret.import_env with commit:false", async () => {
    mockInvoke.mockResolvedValue({ rows: PREVIEW_ROWS, committed: false });

    const res = await importEnvAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      text: "DATABASE_URL=postgres://localhost/db\nLOG_LEVEL=info",
      environmentId: null,
      commit: false,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.committed).toBe(false);
    expect(res.rows).toEqual(PREVIEW_ROWS);

    expect(mockInvoke).toHaveBeenCalledWith(
      "import_env_secrets",
      {
        text: "DATABASE_URL=postgres://localhost/db\nLOG_LEVEL=info",
        environmentId: null,
        commit: false,
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    // Preview path must NOT revalidate
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("commit path: returns committed:true, calls invoke with commit:true, calls revalidatePath", async () => {
    mockInvoke.mockResolvedValue({ rows: PREVIEW_ROWS, committed: true });

    const res = await importEnvAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      text: "DATABASE_URL=postgres://localhost/db",
      commit: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.committed).toBe(true);

    expect(mockInvoke).toHaveBeenCalledWith(
      "import_env_secrets",
      expect.objectContaining({ commit: true }),
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/workbench/environments",
    );
  });

  it("undefined environmentId is coerced to null in the invoke call", async () => {
    mockInvoke.mockResolvedValue({ rows: [], committed: false });

    await importEnvAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      text: "KEY=val",
      // environmentId intentionally omitted
      commit: false,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "import_env_secrets",
      expect.objectContaining({ environmentId: null }),
      expect.any(Object),
      { surface: "agent" },
    );
  });

  it("role gate: member role → ok:false with 'owners or admins' message, invoke NOT called", async () => {
    dbState.wsRoleRows = [{ role: "member" }];

    const res = await importEnvAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      text: "KEY=value",
      commit: false,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/owners or admins/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("role gate: viewer role → ok:false, invoke NOT called", async () => {
    dbState.wsRoleRows = [{ role: "viewer" }];

    const res = await importEnvAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      text: "KEY=value",
      commit: false,
    });

    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false propagating the error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("parse error: unclosed quote"));

    const res = await importEnvAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      text: 'INVALID="unclosed',
      commit: false,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe("parse error: unclosed quote");
  });
});

// ---------------------------------------------------------------------------
// setDefaultEnvironmentAction
// ---------------------------------------------------------------------------

describe("setDefaultEnvironmentAction", () => {
  const ENV = {
    id: "env-1",
    name: "Production",
    slug: "production",
    description: null,
    isDefault: true,
    isActive: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "admin" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("calls invoke with environment.set_default and returns ok:true with environment", async () => {
    mockInvoke.mockResolvedValue({ environment: ENV });

    const res = await setDefaultEnvironmentAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      environmentId: "env-1",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.environment).toEqual(ENV);

    expect(mockInvoke).toHaveBeenCalledWith(
      "set_default_environment",
      { environmentId: "env-1" },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/workbench/environments",
    );
  });

  it("role gate: member role → ok:false, invoke NOT called", async () => {
    dbState.wsRoleRows = [{ role: "member" }];

    const res = await setDefaultEnvironmentAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      environmentId: "env-1",
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/owners or admins/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("environment not found"));

    const res = await setDefaultEnvironmentAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      environmentId: "env-missing",
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe("environment not found");
  });
});

// ---------------------------------------------------------------------------
// upsertKeyAction
// ---------------------------------------------------------------------------

describe("upsertKeyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("happy path: calls invoke with secret.key.upsert and returns ok:true + id", async () => {
    mockInvoke.mockResolvedValue({ id: "key-abc123" });

    const res = await upsertKeyAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      key: "DATABASE_URL",
      sensitive: true,
      memo: "Primary database connection",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.id).toBe("key-abc123");

    expect(mockInvoke).toHaveBeenCalledWith(
      "upsert_secret_key",
      expect.objectContaining({
        key: "DATABASE_URL",
        sensitive: true,
        memo: "Primary database connection",
      }),
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/workbench/environments",
    );
  });

  it("role gate: member role → ok:false, invoke NOT called", async () => {
    dbState.wsRoleRows = [{ role: "member" }];

    const res = await upsertKeyAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      key: "SOME_KEY",
      sensitive: false,
    });

    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
