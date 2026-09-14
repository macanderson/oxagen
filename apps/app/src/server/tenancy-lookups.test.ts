import { beforeEach, describe, expect, it, vi } from "vitest";

// Each lookup issues one to two sequential queries. The fake transaction pops a
// scripted result per query, and records the table each query read.
const { queue, tables, withSystemDbMock } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const tables: unknown[] = [];
  const limit = vi.fn(() => Promise.resolve(queue.shift() ?? []));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn((table: unknown) => {
    tables.push(table);
    return { where };
  });
  const tx = { select: vi.fn(() => ({ from })) };
  const withSystemDbMock = vi.fn((fn: (t: typeof tx) => Promise<unknown>) =>
    fn(tx),
  );
  return { queue, tables, withSystemDbMock };
});

vi.mock("@oxagen/database", async () => ({
  schema: await vi.importActual("@oxagen/database/schema"),
  withSystemDb: withSystemDbMock,
}));

import * as schema from "@oxagen/database/schema";
import { liveTenancyLookups as l } from "./tenancy-lookups";

const orgRow = {
  id: "11111111-1111-4111-8111-111111111111",
  publicId: "org_a",
  slug: "acme",
  name: "Acme Robotics",
  avatarUrl: null,
};
const wsRow = {
  id: "22222222-2222-4222-8222-222222222222",
  publicId: "wks_a",
  orgId: orgRow.id,
  slug: "core-platform",
  name: "Core platform",
  description: null,
};

beforeEach(() => {
  queue.length = 0;
  tables.length = 0;
});

describe("liveTenancyLookups", () => {
  it("resolves an organization by current slug through the RLS-bypassing system seam", async () => {
    queue.push([orgRow]);
    await expect(l.orgBySlug("acme")).resolves.toEqual({
      id: orgRow.id,
      publicId: "org_a",
      slug: "acme",
      name: "Acme Robotics",
    });
    expect(withSystemDbMock).toHaveBeenCalled();
    expect(tables).toEqual([schema.organizations]);
  });

  it("returns null for an unknown slug", async () => {
    queue.push([]);
    await expect(l.orgBySlug("nope")).resolves.toBeNull();
  });

  it("follows organization slug history to the organization by id", async () => {
    queue.push([{ orgId: orgRow.id }], [orgRow]);
    await expect(l.orgBySlugHistory("acme-robotics")).resolves.toMatchObject({
      slug: "acme",
    });
    expect(tables).toEqual([schema.orgSlugHistory, schema.organizations]);
  });

  it("returns null when no redirect-enabled history row exists", async () => {
    queue.push([]);
    await expect(l.orgBySlugHistory("old")).resolves.toBeNull();
    expect(tables).toEqual([schema.orgSlugHistory]);
  });

  it("returns null when the renamed organization was since deleted", async () => {
    queue.push([{ orgId: orgRow.id }], []);
    await expect(l.orgBySlugHistory("old")).resolves.toBeNull();
  });

  it("resolves a workspace by slug within its organization", async () => {
    queue.push([wsRow]);
    await expect(
      l.workspaceBySlug(orgRow.id, "core-platform"),
    ).resolves.toEqual({
      id: wsRow.id,
      publicId: "wks_a",
      orgId: orgRow.id,
      slug: "core-platform",
      name: "Core platform",
    });
    queue.push([]);
    await expect(l.workspaceBySlug(orgRow.id, "nope")).resolves.toBeNull();
  });

  it("follows workspace slug history, and returns null on a miss or a deleted workspace", async () => {
    queue.push([{ workspaceId: wsRow.id }], [wsRow]);
    await expect(
      l.workspaceBySlugHistory(orgRow.id, "platform"),
    ).resolves.toMatchObject({ slug: "core-platform" });
    expect(tables).toEqual([schema.workspaceSlugHistory, schema.workspaces]);
    queue.push([]);
    await expect(l.workspaceBySlugHistory(orgRow.id, "x")).resolves.toBeNull();
    queue.push([{ workspaceId: wsRow.id }], []);
    await expect(l.workspaceBySlugHistory(orgRow.id, "y")).resolves.toBeNull();
  });

  it("lowercases the organization role, and returns null for a non-member", async () => {
    queue.push([{ role: "Admin" }]);
    await expect(l.orgRole(orgRow.id, "u1")).resolves.toBe("admin");
    queue.push([]);
    await expect(l.orgRole(orgRow.id, "u2")).resolves.toBeNull();
    queue.push([{ role: "" }]);
    await expect(l.orgRole(orgRow.id, "u3")).resolves.toBeNull();
  });

  it("answers workspace membership", async () => {
    queue.push([{ id: "wu1" }]);
    await expect(l.isWorkspaceMember(wsRow.id, "u1")).resolves.toBe(true);
    queue.push([]);
    await expect(l.isWorkspaceMember(wsRow.id, "u2")).resolves.toBe(false);
    expect(tables).toEqual([schema.workspaceUsers, schema.workspaceUsers]);
  });

  it("reads the MFA policy and the enrollment flag", async () => {
    const policy = {
      mfaRequired: true,
      mfaGraceHours: 48,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    };
    queue.push([policy]);
    await expect(l.mfaPolicy(orgRow.id)).resolves.toEqual(policy);
    queue.push([]);
    await expect(l.mfaPolicy(orgRow.id)).resolves.toBeNull();
    queue.push([{ enabled: true }]);
    await expect(l.twoFactorEnabled("u1")).resolves.toBe(true);
    queue.push([]);
    await expect(l.twoFactorEnabled("u2")).resolves.toBe(false);
    expect(tables).toEqual([
      schema.orgSecurityPolicy,
      schema.orgSecurityPolicy,
      schema.users,
      schema.users,
    ]);
  });
});
