// The `/` landing over the pretenant port: the first organization the viewer
// joined and its first workspace, /new-organization with no organization, the
// organization's People page with no workspace, and a refused or failed read
// thrown for the error page with no redirect.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Redirect, redirectTo, requireUser } = vi.hoisted(() => {
  class Redirect extends Error {}
  return {
    Redirect,
    redirectTo: vi.fn((path: string) => {
      throw new Redirect(path);
    }),
    requireUser: vi.fn(),
  };
});
vi.mock("@/shared/navigation", () => ({ redirectTo }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireUser,
}));

const { PretenantCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { Landing } = await import("./landing");

const ctx = unsafeMint(PretenantCtx, { userId: "usr_marcusbell" });
const orgs = vi.fn();
const workspaces = vi.fn();
const source = {
  pretenant: { orgs, workspaces },
  shell: { context: vi.fn(), preferences: vi.fn() },
  billing: {
    plan: vi.fn(),
    usageCredits: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: {
    list: vi.fn(),
    get: vi.fn(),
    frameBody: vi.fn(),
    cost: vi.fn(),
    transcript: vi.fn(),
    chain: vi.fn(),
    outputs: vi.fn(),
  },
  approvals: { pending: vi.fn(), resolved: vi.fn() },
  agents: {
    list: vi.fn(),
    get: vi.fn(),
    toolbelt: vi.fn(),
    incidents: vi.fn(),
  },
  spend: {
    byGroup: vi.fn(),
    fleet: vi.fn(),
    drill: vi.fn(),
    waste: vi.fn(),
    gatewayPolicy: vi.fn(),
    budgets: vi.fn(),
    findings: vi.fn(),
    findingEvidence: vi.fn(),
    priceBook: vi.fn(),
    unpricedModels: vi.fn(),
  },
  onboarding: { state: vi.fn(), firstFrame: vi.fn() },
  org: {
    members: vi.fn(),
    roles: vi.fn(),
    workspaces: vi.fn(),
    apiKeys: vi.fn(),
    costCenters: vi.fn(),
    modelCredential: vi.fn(),
    sso: vi.fn(),
  },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: { events: vi.fn(), exportEvents: vi.fn() },
  skills: { inventory: vi.fn(), configuration: vi.fn() },
  steering: {
    records: vi.fn(),
    record: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
  },
  tools: {
    versions: vi.fn(),
    grants: vi.fn(),
    killSwitches: vi.fn(),
    approvalRules: vi.fn(),
    connections: vi.fn(),
    mcpServers: vi.fn(),
  },
};

const acme = { slug: "acme", name: "Acme Robotics" };
const globex = { slug: "globex", name: "Globex" };

beforeEach(() => {
  requireUser.mockReset();
  requireUser.mockResolvedValue(ctx);
  orgs.mockReset();
  workspaces.mockReset();
});

/** The path the landing redirected to. */
async function landsOn(): Promise<string> {
  const outcome = await Landing({ source }).catch((e: unknown) => e);
  if (!(outcome instanceof Redirect)) throw outcome;
  return outcome.message;
}

describe("the / landing", () => {
  it("opens the first workspace of the viewer's one organization", async () => {
    orgs.mockResolvedValue(readOk([acme]));
    workspaces.mockResolvedValue(
      readOk([
        { slug: "core-platform", name: "Core platform" },
        { slug: "finops", name: "FinOps" },
      ]),
    );
    expect(await landsOn()).toBe("/acme/core-platform");
    expect(orgs).toHaveBeenCalledWith(ctx);
    expect(workspaces).toHaveBeenCalledWith(ctx, "acme");
  });

  it("opens the first organization list_orgs returns, the one joined first, and reads no other", async () => {
    orgs.mockResolvedValue(readOk([globex, acme]));
    workspaces.mockResolvedValue(readOk([{ slug: "ops", name: "Ops" }]));
    expect(await landsOn()).toBe("/globex/ops");
    expect(workspaces).toHaveBeenCalledTimes(1);
  });

  it("sends a person with no organization to create one", async () => {
    orgs.mockResolvedValue(readOk([]));
    expect(await landsOn()).toBe("/new-organization");
    expect(workspaces).not.toHaveBeenCalled();
  });

  it("opens the organization's People page when it has no workspace the viewer can open", async () => {
    orgs.mockResolvedValue(readOk([acme]));
    workspaces.mockResolvedValue(readOk([]));
    expect(await landsOn()).toBe("/acme");
  });

  it("throws a denied organizations read for the error page, redirecting nowhere (negative)", async () => {
    orgs.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.read",
    });
    await expect(Landing({ source })).rejects.toThrow("landing_denied");
    expect(redirectTo).not.toHaveBeenCalled();
    expect(workspaces).not.toHaveBeenCalled();
  });

  it("throws a failed workspaces read for the error page, redirecting nowhere (negative)", async () => {
    orgs.mockResolvedValue(readOk([acme]));
    workspaces.mockResolvedValue(readError("control_plane_unavailable", 503));
    await expect(Landing({ source })).rejects.toThrow("landing_error");
    expect(redirectTo).not.toHaveBeenCalled();
  });

  it("reads nothing for a signed-out person, whom requireUser sends to sign in (negative)", async () => {
    requireUser.mockRejectedValue(new Redirect("/login"));
    await expect(Landing({ source })).rejects.toThrow("/login");
    expect(orgs).not.toHaveBeenCalled();
  });
});
