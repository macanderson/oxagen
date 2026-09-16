// Typed Organization values for the Organization component tests
// (ARCHITECTURE.md §5): a role row, a catalogue entry, the roles read, and a
// workspace row. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import type {
  Permission,
  Role,
  RoleCatalog,
  Workspace,
} from "@/data/contracts/org";

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

export function roleCatalog(
  overrides: Partial<RoleCatalog> = {},
): RoleCatalog {
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
