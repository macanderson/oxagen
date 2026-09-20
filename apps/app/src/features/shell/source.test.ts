// shellSource: the organization and the person the layout's context admits,
// and the shell.context read for that context. This file proves the shell
// receives the context's organization, the session's person and the port's
// read, and refuses to render without a session.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthUser = vi.fn();
vi.mock("@/features/auth", () => ({ getAuthUser }));
const getSession = vi.fn();
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { shellSource } = await import("./source");

const ctx = unsafeMint(OrgCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const context = vi.fn();
const preferences = vi.fn();
const source = {
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: { context, preferences },
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
    modelCredential: vi.fn(),
  },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: { events: vi.fn(), exportEvents: vi.fn() },
  skills: { inventory: vi.fn() },
  steering: {
    records: vi.fn(),
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
const listed = readOk({
  orgs: [{ slug: "acme", name: "Acme Robotics" }],
  workspaces: [{ slug: "core-platform", name: "Core platform" }],
});

beforeEach(() => {
  context.mockReset();
  context.mockResolvedValue(listed);
  preferences.mockReset();
  preferences.mockResolvedValue(readOk({ timeZone: "Europe/London" }));
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue({
    id: "usr_marcusbell",
    email: "marcus.bell@acme.example",
    name: "Marcus Bell",
    avatarUrl: null,
    emailVerified: true,
    twoFactorEnabled: true,
  });
});

describe("shellSource", () => {
  it("hands the context's organization, the signed-in person, their zone and the shell.context read to the shell", async () => {
    expect(await shellSource(ctx, source)).toEqual({
      org: { slug: "acme", name: "Acme Robotics" },
      viewer: {
        name: "Marcus Bell",
        email: "marcus.bell@acme.example",
        avatarUrl: null,
        id: "usr_marcusbell",
        orgRole: ctx.orgRole,
        emailVerified: true,
        twoFactorEnabled: true,
        timeZone: "Europe/London",
      },
      context: listed,
      fleetWaiting: null,
    });
    expect(context).toHaveBeenCalledWith(ctx);
    expect(preferences).toHaveBeenCalledWith(ctx);
  });

  it("renders the chrome in Pacific time when the preference read fails (negative)", async () => {
    preferences.mockResolvedValue(readError("control_plane_unavailable", 503));
    expect((await shellSource(ctx, source)).viewer.timeZone).toBe(
      "America/Los_Angeles",
    );
  });

  it("passes a failed shell.context read through, and the shell still renders (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    context.mockResolvedValue(down);
    expect((await shellSource(ctx, source)).context).toEqual(down);
  });

  it("keeps a person with no recorded name as null, never an invented one", async () => {
    getAuthUser.mockResolvedValue({
      id: "usr_marcusbell",
      email: "marcus.bell@acme.example",
      name: "",
      avatarUrl: null,
      emailVerified: false,
      twoFactorEnabled: false,
    });
    expect((await shellSource(ctx, source)).viewer).toMatchObject({
      name: null,
      email: "marcus.bell@acme.example",
      avatarUrl: null,
      timeZone: "Europe/London",
    });
  });

  it("refuses to render without a session (negative)", async () => {
    getAuthUser.mockResolvedValue(null);
    await expect(shellSource(ctx, source)).rejects.toThrow(
      "shell_without_session",
    );
  });
});
