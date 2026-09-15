import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock("next/navigation", () => ({ redirect }));
const getAuthUser = vi.fn();
vi.mock("../auth/session", () => ({ getAuthUser }));

// --- the live write's collaborators -------------------------------------------------
const inserted: Array<{ table: string; values: Record<string, unknown> }> = [];
let failInsert: Error | null = null;
/** A unique-constraint violation as Postgres reports it through drizzle. */
class UniqueViolation extends Error {
  constructor(readonly constraint: string) {
    super("unique");
  }
}
const schema = {
  organizations: "organizations",
  orgUsers: "orgUsers",
  workspaces: "workspaces",
  workspaceUsers: "workspaceUsers",
};
const tx = {
  insert: (table: string) => ({
    values: (values: Record<string, unknown>) => {
      const failure = table === "organizations" ? failInsert : null;
      if (!failure) inserted.push({ table, values });
      const settled: Promise<undefined> = failure
        ? Promise.reject(failure)
        : Promise.resolve(undefined);
      settled.catch(() => undefined);
      return {
        then: settled.then.bind(settled),
        returning: () =>
          failure
            ? Promise.reject(failure)
            : Promise.resolve([{ ...values, id: `${table}-id` }]),
      };
    },
  }),
};
const isUniqueViolation = vi.fn(
  (err: unknown, constraint?: string) =>
    (typeof err === "object" && err !== null && "constraint" in err
      ? err.constraint
      : undefined) === constraint,
);
vi.mock("@oxagen/database", () => ({
  schema,
  withSystemDb: (fn: (t: unknown) => unknown) => fn(tx),
  deriveNamespace: (seed: string) => seed.replace(/-/g, "").slice(0, 6),
  isUniqueViolation,
}));
const logger = { error: vi.fn(), warn: vi.fn() };
vi.mock("@oxagen/handlers/logger", () => ({ logger }));
const bootstrapOrgIAM = vi.fn();
const bootstrapWorkspaceAgents = vi.fn();
vi.mock("@oxagen/handlers/iam-provision", () => ({ bootstrapOrgIAM }));
vi.mock("@oxagen/handlers/workspace-agents", () => ({
  bootstrapWorkspaceAgents,
}));
// Nothing billing-shaped is written at creation: loading the package is the defect.
vi.mock("@oxagen/billing", () => {
  throw new Error("createOrganization must not load @oxagen/billing");
});
const seedRegistry = vi.fn();
const seedEnvironment = vi.fn();
vi.mock("@oxagen/handlers/workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistrySystem: seedRegistry,
}));
vi.mock("@oxagen/handlers/workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironmentSystem: seedEnvironment,
}));
// The reserved-slug sets are the contract's own; only the parse is faked.
vi.mock("@oxagen/oxagen/contracts/org.create", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@oxagen/oxagen/contracts/org.create")
  >()),
  organizationCreate: {
    input: {
      safeParse: (v: { name: string; slug: string; type: string }) =>
        v.slug === "contract-refuses"
          ? { success: false }
          : { success: true, data: { ...v, planSlug: "free" } },
    },
  },
}));
vi.mock("@oxagen/oxagen/contracts/workspace.create", () => ({
  workspaceCreate: {
    input: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  },
}));

const { createOrganizationAction } = await import("./actions");
const { createOrganization } = await import("./create-organization");

const form = {
  name: "Acme Robotics",
  slug: "acme",
  namespace: "acme",
  workspaceName: "Core platform",
  workspaceSlug: "core-platform",
};
const user = { id: "u-owner", email: "priya@acme.example", name: "Priya" };

beforeEach(() => {
  inserted.length = 0;
  failInsert = null;
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue(user);
  for (const fn of [
    logger.error,
    bootstrapOrgIAM,
    bootstrapWorkspaceAgents,
    seedRegistry,
    seedEnvironment,
  ])
    fn.mockReset();
});

describe("createOrganizationAction", () => {
  it("sends a signed-out person to log in", async () => {
    getAuthUser.mockResolvedValue(null);
    await expect(createOrganizationAction(form)).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Fnew-organization",
    );
  });

  it("re-validates every field, writing nothing (negative)", async () => {
    expect(
      await createOrganizationAction({
        ...form,
        namespace: "toolong7",
        workspaceSlug: "billing",
      }),
    ).toEqual({
      ok: false,
      fields: {
        namespace: "namespaceInvalid",
        workspaceSlug: "workspaceSlugReserved",
      },
    });
    expect(inserted).toHaveLength(0);
  });

  it("refuses an organization address that is a top-level route, writing nothing (negative)", async () => {
    for (const slug of ["new-organization", "login", "api"])
      expect(await createOrganizationAction({ ...form, slug })).toEqual({
        ok: false,
        fields: { slug: "slugReserved" },
      });
    expect(inserted).toHaveLength(0);
  });

  it("creates the tenant and lands on its first workspace's Fleet page", async () => {
    expect(await createOrganizationAction(form)).toEqual({
      ok: true,
      to: "/acme/core-platform",
    });
  });

  it("maps a taken address, a taken namespace, a contract refusal and a failure", async () => {
    failInsert = new UniqueViolation("organizations_slug_idx");
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      fields: { slug: "slugTaken" },
    });
    failInsert = new UniqueViolation("organizations_namespace_idx");
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      fields: { namespace: "namespaceTaken" },
    });
    failInsert = null;
    expect(
      await createOrganizationAction({ ...form, slug: "contract-refuses" }),
    ).toEqual({ ok: false, fields: { slug: "slugInvalid" } });
    failInsert = new Error("connection reset");
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      error: "failed",
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("createOrganization", () => {
  it("re-checks reserved addresses before any write, so a crafted call cannot skip the form", async () => {
    for (const slug of ["new-organization", "login", "api"])
      expect(await createOrganization("u-owner", { ...form, slug })).toEqual({
        ok: false,
        error: "slugReserved",
      });
    expect(
      await createOrganization("u-owner", {
        ...form,
        workspaceSlug: "billing",
      }),
    ).toEqual({ ok: false, error: "workspaceSlugReserved" });
    expect(inserted).toHaveLength(0);
  });

  it("writes the org with the chosen namespace, both owner memberships and the workspace, then bootstraps IAM and agents", async () => {
    const result = await createOrganization("u-owner", form);
    expect(result).toEqual({
      ok: true,
      orgSlug: "acme",
      workspaceSlug: "core-platform",
    });
    expect(inserted.map((i) => i.table)).toEqual([
      "organizations",
      "orgUsers",
      "workspaces",
      "workspaceUsers",
    ]);
    expect(inserted[0]?.values).toMatchObject({
      name: "Acme Robotics",
      slug: "acme",
      namespace: "acme",
      planType: "free",
      status: "active",
    });
    expect(inserted[1]?.values).toMatchObject({
      role: "owner",
      userId: "u-owner",
    });
    expect(inserted[2]?.values).toMatchObject({
      name: "Core platform",
      slug: "core-platform",
      namespace: "corepl",
    });
    expect(bootstrapOrgIAM).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "organizations-id",
        ownerUserId: "u-owner",
      }),
    );
    expect(bootstrapWorkspaceAgents).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspaces-id" }),
    );
    expect(seedRegistry).toHaveBeenCalledOnce();
    expect(seedEnvironment).toHaveBeenCalledOnce();
  });

  it("a failed seed is logged and does not fail sign-up", async () => {
    seedEnvironment.mockRejectedValue(new Error("seed"));
    expect((await createOrganization("u-owner", form)).ok).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(seedRegistry).toHaveBeenCalledOnce();
  });
});
