// Typed Organization values for the Organization component tests
// (ARCHITECTURE.md §5): a role row, a catalogue entry, the roles read, a
// workspace row, one API key, and a DataSource that answers the four
// organization reads with what a test hands it while recording the arguments
// it was called with. Every other port refuses, so a section that reads
// outside its own port fails the test rather than passing on a stub.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import { refusingSource } from "@/test/refusing-source";
import type {
  ApiKey,
  ModelCredential,
  MemberList,
  Permission,
  Role,
  RoleCatalog,
  Workspace,
  WorkspaceList,
} from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";

export function permissionEntry(
  overrides: Partial<Permission> = {},
): Permission {
  return {
    permission: "run.read",
    group: "Runs",
    description: "Read runs, their approvals and the commands sent to them",
    capabilities: ["list_runs", "get_run", "list_approvals"],
    ...overrides,
  };
}

export function roleRow(overrides: Partial<Role> = {}): Role {
  return {
    id: "rol_7k2m9q4x8r1t5v3w6y0z2a",
    name: "agent.release",
    description: "Cuts releases and opens their pull requests.",
    scope: "workspace",
    kind: "agent",
    builtIn: false,
    permissions: ["run.read"],
    heldBy: 2,
    createdBy: "Priya Natarajan",
    ...overrides,
  };
}

export function roleCatalog(overrides: Partial<RoleCatalog> = {}): RoleCatalog {
  return {
    roles: [roleRow()],
    catalog: [permissionEntry()],
    enforcement: { tier: "enterprise", enforced: true },
    ...overrides,
  };
}

export function workspaceRow(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "wrk_0a1b2c3d4e5f6g7h8j9k0m",
    slug: "core-platform",
    name: "Core platform",
    role: "Owner",
    archivedAt: null,
    ...overrides,
  };
}

export function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
    name: "CI runner",
    prefix: "ox_liveliveli",
    createdAt: "2026-09-13T10:00:00.000Z",
    lastUsedAt: "2026-09-14T11:30:00.000Z",
    expiresAt: null,
    revokedAt: null,
    rotatable: true,
    ...overrides,
  };
}

type OrgReads = {
  members?: Read<MemberList>;
  roles?: Read<RoleCatalog>;
  workspaces?: Read<WorkspaceList>;
  apiKeys?: Read<ApiKey[]>;
  modelCredential?: Read<ModelCredential>;
};

export function orgSource(reads: OrgReads): {
  source: DataSource;
  calls: Record<keyof OrgReads, unknown[][]>;
} {
  const calls: Record<keyof OrgReads, unknown[][]> = {
    members: [],
    roles: [],
    workspaces: [],
    apiKeys: [],
    modelCredential: [],
  };

  const answer =
    <T>(read: Read<T> | undefined, name: keyof OrgReads) =>
    (...args: unknown[]): Promise<Read<T>> => {
      calls[name].push(args);
      return read === undefined
        ? Promise.reject(new Error(`org.${name} was not expected`))
        : Promise.resolve(read);
    };
  const source: DataSource = refusingSource("Organization", {
    org: {
      members: answer(reads.members, "members"),
      roles: answer(reads.roles, "roles"),
      workspaces: answer(reads.workspaces, "workspaces"),
      apiKeys: answer(reads.apiKeys, "apiKeys"),
      modelCredential: answer(reads.modelCredential, "modelCredential"),
    },
  });
  return { source, calls };
}
