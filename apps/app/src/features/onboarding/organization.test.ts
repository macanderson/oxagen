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
      return Object.assign(settled, {
        returning: () =>
          failure
            ? Promise.reject(failure)
            : Promise.resolve([{ ...values, id: `${table}-id` }]),
      });
    },
  }),
};
const isUniqueViolation = vi.fn(
  (err: unknown, constraint?: string) =>
    (err as { constraint?: string }).constraint === constraint,
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
const grantFreeCredits = vi.fn();
vi.mock("@oxagen/billing", () => ({ grantFreeCredits }));
const seedRegistry = vi.fn();
const seedEnvironment = vi.fn();
vi.mock("@oxagen/handlers/workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistrySystem: seedRegistry,
}));
vi.mock("@oxagen/handlers/workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironmentSystem: seedEnvironment,
}));
vi.mock("@oxagen/oxagen/contracts/org.create", () => ({
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

function mode(m: "fixture" | "live") {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", m);
}

beforeEach(() => {
  inserted.length = 0;
  failInsert = null;
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue(user);
  for (const fn of [
    logger.error,
    bootstrapOrgIAM,
    bootstrapWorkspaceAgents,
    grantFreeCredits,
    seedRegistry,
    seedEnvironment,
  ])
    fn.mockReset();
});

describe("createOrganizationAction", () => {
  it("sends a signed-out person to log in", async () => {
    mode("fixture");
    getAuthUser.mockResolvedValue(null);
    await expect(createOrganizationAction(form)).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Fwelcome",
    );
  });

  it("re-validates every field", async () => {
    mode("fixture");
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
  });

  it("refuses an organization address that is a top-level route", async () => {
    mode("fixture");
    for (const slug of ["welcome", "login", "api"])
      expect(await createOrganizationAction({ ...form, slug })).toEqual({
        ok: false,
        fields: { slug: "slugReserved" },
      });
  });

  it("fixture · moves on to wrap in the fixture org, writing nothing", async () => {
    mode("fixture");
    expect(await createOrganizationAction(form)).toEqual({
      ok: true,
      to: "/welcome/wrap?org=acme&ws=core-platform",
    });
    expect(inserted).toHaveLength(0);
  });

  it("live · creates the tenant and moves on to its wrap step", async () => {
    mode("live");
    expect(await createOrganizationAction(form)).toEqual({
      ok: true,
      to: "/welcome/wrap?org=acme&ws=core-platform",
    });
  });

  it("live · maps a taken address, a taken namespace, a contract refusal and a failure", async () => {
    mode("live");
    failInsert = Object.assign(new Error("unique"), {
      constraint: "organizations_slug_idx",
    });
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      fields: { slug: "slugTaken" },
    });
    failInsert = Object.assign(new Error("unique"), {
      constraint: "organizations_namespace_idx",
    });
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
    mode("live");
    for (const slug of ["welcome", "login", "api"])
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
    mode("live");
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
    expect(grantFreeCredits).toHaveBeenCalledWith("organizations-id");
    expect(seedRegistry).toHaveBeenCalledOnce();
    expect(seedEnvironment).toHaveBeenCalledOnce();
  });

  it("a failed credit grant or seed is logged and does not fail sign-up", async () => {
    mode("live");
    grantFreeCredits.mockRejectedValue(new Error("stripe"));
    seedEnvironment.mockRejectedValue(new Error("seed"));
    expect((await createOrganization("u-owner", form)).ok).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(seedRegistry).toHaveBeenCalledOnce();
  });
});
