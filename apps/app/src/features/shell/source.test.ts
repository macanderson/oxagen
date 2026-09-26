// shellSource: the organization and the person the layout's context admits,
// the shell.context read for that context, and the approvals drawer's reads
// across the organization's workspaces. This file proves the shell receives
// the context's organization, the session's person and the port's read, reads
// each workspace in its own resolved scope up to a bound, reads the mandate
// ledger only where a parked call names one, and refuses to render without a
// session.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "@/data/ports";

const getAuthUser = vi.fn();
vi.mock("@/features/auth", () => ({ getAuthUser }));
const getSession = vi.fn();
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
const requireViewer = vi.fn();
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { shellSource, startOfViewerDay, WORKSPACE_BOUND } = await import(
  "./source"
);

const ctx = unsafeMint(OrgCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const context = vi.fn();
const preferences = vi.fn();
const notifications = vi.fn();
const counts = vi.fn();
const assistantEngine = vi.fn();
const pending = vi.fn();
const openInterjections = vi.fn<DataSource["interjections"]["open"]>();
const resolvedSince = vi.fn<DataSource["approvals"]["resolvedSince"]>();
const mandatesList = vi.fn();
const source = {
  runtimes: { list: vi.fn(), agents: vi.fn() },
  conversations: { latest: vi.fn() },
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: { context, preferences, counts, notifications, assistantEngine },
  billing: {
    plan: vi.fn(),
    usageCredits: vi.fn(),
    retention: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: {
    list: vi.fn(),
    get: vi.fn(),
    frameBody: vi.fn(),
    cost: vi.fn(),
    turns: vi.fn(),
    transcript: vi.fn(),
    chain: vi.fn(),
    outputs: vi.fn(),
    work: vi.fn(),
    outcomesSettings: vi.fn(),
  },
  approvals: { pending, resolved: vi.fn(), resolvedSince },
  interjections: { open: openInterjections },
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
    dataPlane: vi.fn(),
    workspaceFacts: vi.fn(),
    sso: vi.fn(),
  },
  mandates: { list: mandatesList, get: vi.fn() },
  audit: {
    events: vi.fn(),
    exportEvents: vi.fn(),
    retention: vi.fn(),
    bundle: vi.fn(),
  },
  skills: { inventory: vi.fn(), configuration: vi.fn() },
  steering: {
    records: vi.fn(),
    record: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
    hub: vi.fn(),
    deliveries: vi.fn(),
    memories: vi.fn(),
    tree: vi.fn(),
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

const emptyQueue = readOk({ items: [], more: false });
const feed = readOk({ items: [], unread: 2 });
const parked = {
  id: "apr_01K5RS8F3J",
  runId: null,
  tool: "stripe__create_payment@4",
  agentKey: "acme.finops.invoice-bot",
  requester: null,
  mandateId: "mnd_7K2ETQ4",
  rule: "mandate:mnd_7K2ETQ4:human_above:amount",
  autoEligibility: null,
  createdAt: "2026-09-23T09:31:08Z",
  expiresAt: "2026-09-23T09:41:08Z",
};

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockImplementation((org: string, ws: string) =>
    Promise.resolve({ org, ws }),
  );
  notifications.mockReset();
  notifications.mockResolvedValue(feed);
  counts.mockReset();
  counts.mockResolvedValue(
    readOk({ approvals: 0, interjections: null, proposals: 4, incidents: 1 }),
  );
  pending.mockReset();
  pending.mockResolvedValue(emptyQueue);
  openInterjections.mockReset();
  openInterjections.mockResolvedValue(emptyQueue);
  resolvedSince.mockReset();
  resolvedSince.mockResolvedValue(emptyQueue);
  mandatesList.mockReset();
  context.mockReset();
  context.mockResolvedValue(listed);
  preferences.mockReset();
  preferences.mockResolvedValue(
    readOk({ timeZone: "Europe/London", enterToSubmit: true }),
  );
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
    const { data } = await shellSource(ctx, source);
    // readAt is the instant of the read; check its type, then compare the rest.
    expect(typeof data.approvals.readAt).toBe("number");
    expect({
      ...data,
      approvals: { ...data.approvals, readAt: 0 },
    }).toEqual({
      org: {
        key: createHash("sha256").update(`account:${ctx.orgId}`).digest("hex"),
        slug: "acme",
        name: "Acme Robotics",
      },
      viewer: {
        name: "Marcus Bell",
        email: "marcus.bell@acme.example",
        avatarUrl: null,
        id: "usr_marcusbell",
        orgRole: ctx.orgRole,
        emailVerified: true,
        twoFactorEnabled: true,
        timeZone: "Europe/London",
        enterToSubmit: true,
      },
      context: listed,
      approvals: {
        workspaces: [
          {
            slug: "core-platform",
            name: "Core platform",
            pending: emptyQueue,
            interjections: emptyQueue,
            resolved: emptyQueue,
          },
        ],
        truncated: false,
        readAt: 0,
      },
      feed,
      counts: {
        slug: "core-platform",
        read: readOk({
          approvals: 0,
          interjections: null,
          proposals: 4,
          incidents: 1,
        }),
      },
    });
    expect(context).toHaveBeenCalledWith(ctx);
    expect(preferences).toHaveBeenCalledWith(ctx);
  });

  it("renders the chrome in Pacific time when the preference read fails (negative)", async () => {
    preferences.mockResolvedValue(readError("control_plane_unavailable", 503));
    expect((await shellSource(ctx, source)).data.viewer.timeZone).toBe(
      "America/Los_Angeles",
    );
  });

  // A failed read must not turn Enter into a send the person never chose.
  it("leaves Enter adding a line when the preference read fails (negative)", async () => {
    preferences.mockResolvedValue(readError("control_plane_unavailable", 503));
    expect((await shellSource(ctx, source)).data.viewer.enterToSubmit).toBe(
      false,
    );
  });

  it("passes a failed shell.context read through, and the shell still renders (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    context.mockResolvedValue(down);
    const { data } = await shellSource(ctx, source);
    expect(data.context).toEqual(down);
    // With no workspace list there is nothing to read approvals in. The bell
    // still reads the organization's own rows in the organization's scope.
    expect(data.approvals.workspaces).toEqual([]);
    expect(pending).not.toHaveBeenCalled();
    expect(notifications).toHaveBeenCalledWith(ctx);
    expect(data.feed).toEqual(feed);
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
    expect((await shellSource(ctx, source)).data.viewer).toMatchObject({
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

it("keys account state by immutable organization identity across slug changes", async () => {
  const original = await shellSource(ctx, source);
  const renamed = await shellSource(
    unsafeMint(OrgCtx, {
      userId: ctx.userId,
      orgId: ctx.orgId,
      orgSlug: "renamed",
      orgName: ctx.orgName,
      orgRole: ctx.orgRole,
    }),
    source,
  );
  const replacement = await shellSource(
    unsafeMint(OrgCtx, {
      userId: ctx.userId,
      orgId: "7a000000-0000-4000-8000-0000000000b2",
      orgSlug: ctx.orgSlug,
      orgName: ctx.orgName,
      orgRole: ctx.orgRole,
    }),
    source,
  );
  expect(renamed.data.org.key).toBe(original.data.org.key);
  expect(replacement.data.org.key).not.toBe(original.data.org.key);
  expect(original.data.org.key).not.toContain(ctx.orgId);
});

describe("shellSource across the organization's workspaces", () => {
  it("reads each workspace's queue and today's resolutions in that workspace's own resolved scope", async () => {
    await shellSource(ctx, source);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    const wsCtx = { org: "acme", ws: "core-platform" };
    expect(pending).toHaveBeenCalledWith(wsCtx, { runId: null });
    // The open questions, in the same scope, for the drawer's first rows (#3839).
    expect(openInterjections).toHaveBeenCalledWith(wsCtx, { runId: null });
    expect(resolvedSince).toHaveBeenCalledOnce();
    const [scope, window] = resolvedSince.mock.calls[0] ?? [];
    expect(scope).toEqual(wsCtx);
    expect(window?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(notifications).toHaveBeenCalledWith(wsCtx);
  });

  it("reads the nav counts in the workspace the sidebar points at, for an organization page to draw", async () => {
    const { data } = await shellSource(ctx, source);
    expect(counts).toHaveBeenCalledOnce();
    expect(counts).toHaveBeenCalledWith({ org: "acme", ws: "core-platform" });
    expect(data.counts).toEqual({
      slug: "core-platform",
      read: readOk({
        approvals: 0,
        interjections: null,
        proposals: 4,
        incidents: 1,
      }),
    });
  });

  it("reads no counts when the organization has no workspace to read (negative)", async () => {
    context.mockResolvedValue(readOk({ orgs: [], workspaces: [] }));
    const { data } = await shellSource(ctx, source);
    expect(counts).not.toHaveBeenCalled();
    expect(data.counts).toBeNull();
  });

  it("reads the organization's own notifications for a viewer who can open no workspace (#3806)", async () => {
    context.mockResolvedValue(readOk({ orgs: [], workspaces: [] }));
    const orgRows = readOk({
      items: [
        {
          id: "ntf_01K5RS8F3J",
          title: "Billing contact changed",
          unread: true,
        },
      ],
      unread: 1,
    });
    notifications.mockResolvedValue(orgRows);
    const { data } = await shellSource(ctx, source);
    expect(requireViewer).not.toHaveBeenCalled();
    expect(notifications).toHaveBeenCalledOnce();
    expect(notifications).toHaveBeenCalledWith(ctx);
    expect(data.feed).toEqual(orgRows);
  });

  it("reads the mandate ledger only for a workspace whose parked call names a mandate", async () => {
    pending.mockResolvedValue(readOk({ items: [parked], more: false }));
    const mandate = { id: "mnd_7K2ETQ4" };
    mandatesList.mockResolvedValue(readOk({ mandates: [mandate] }));
    const { cards } = await shellSource(ctx, source);
    expect(mandatesList).toHaveBeenCalledOnce();
    expect(cards.mandates.get("core-platform")?.get("mnd_7K2ETQ4")).toBe(
      mandate,
    );
  });

  it("does not read the ledger when no parked call names a mandate (negative)", async () => {
    pending.mockResolvedValue(
      readOk({ items: [{ ...parked, mandateId: null }], more: false }),
    );
    await shellSource(ctx, source);
    expect(mandatesList).not.toHaveBeenCalled();
  });

  it("stops at the workspace bound and says the count is partial", async () => {
    const many = Array.from({ length: WORKSPACE_BOUND + 3 }, (_, i) => ({
      slug: `ws-${String(i)}`,
      name: `Workspace ${String(i)}`,
    }));
    context.mockResolvedValue(
      readOk({
        orgs: [{ slug: "acme", name: "Acme Robotics" }],
        workspaces: many,
      }),
    );
    const { data } = await shellSource(ctx, source);
    expect(pending).toHaveBeenCalledTimes(WORKSPACE_BOUND);
    expect(data.approvals.workspaces).toHaveLength(WORKSPACE_BOUND);
    expect(data.approvals.truncated).toBe(true);
  });

  it("carries a workspace's refused queue as its refusal, never as an empty one (negative)", async () => {
    const denied = {
      ok: false as const,
      reason: "denied" as const,
      permission: "workspace.read",
    };
    pending.mockResolvedValue(denied);
    const { data } = await shellSource(ctx, source);
    expect(data.approvals.workspaces[0]?.pending).toEqual(denied);
  });

  it("carries a workspace's failed interjections read as its failure, beside its approvals (negative)", async () => {
    const down = readError("record_unmappable", 502);
    openInterjections.mockResolvedValue(down);
    const { data } = await shellSource(ctx, source);
    expect(data.approvals.workspaces[0]?.interjections).toEqual(down);
    expect(data.approvals.workspaces[0]?.pending).toEqual(emptyQueue);
  });
});

describe("startOfViewerDay", () => {
  it("is local midnight in the viewer's zone", () => {
    // 2026-09-23 09:31:08Z is 02:31 in Los Angeles (PDT, UTC-7).
    expect(
      startOfViewerDay(
        Date.parse("2026-09-23T09:31:08Z"),
        "America/Los_Angeles",
      ),
    ).toBe("2026-09-23T07:00:00.000Z");
    // 2026-09-23 02:00Z is still 22 September in Los Angeles.
    expect(
      startOfViewerDay(
        Date.parse("2026-09-23T02:00:00Z"),
        "America/Los_Angeles",
      ),
    ).toBe("2026-09-22T07:00:00.000Z");
  });

  it("is UTC midnight in UTC", () => {
    expect(startOfViewerDay(Date.parse("2026-09-23T09:31:08Z"), "UTC")).toBe(
      "2026-09-23T00:00:00.000Z",
    );
  });
});
