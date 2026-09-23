// The agents port: each method is one kernelRead of its contract with the
// agent and the cursor it was asked for, mapped into its view, with a refusal
// passed through and an unmappable record reported once.
import { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { agentToolbeltGet } from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { agents } = await import("./agents");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const DENIED = { ok: false, reason: "denied", permission: "agent.read" };

const item = {
  id: "agt_releasebot",
  slug: "release-bot",
  name: "Release bot",
  agentKey: null,
  harness: "stella",
  principalId: null,
  operatorId: null,
  status: "unenrolled",
  tier: null,
  beltSize: null,
  runs30d: 0,
  spend30d: null,
  proven30d: null,
  mandates: null,
  incidents: 0,
  credentials: 0,
  hosts: 0,
  registeredAt: "2026-09-01T10:00:00.000Z",
};
const listOut = {
  items: [item],
  nextCursor: null,
  totals: {
    identities: 1,
    enrolled: 0,
    holdingMandate: null,
    tamperIncidents: 0,
  },
};
const getOut = {
  identity: {
    id: "agt_releasebot",
    slug: "release-bot",
    name: "Release bot",
    description: null,
    agentKey: null,
    harness: "stella",
    principalId: null,
    operatorId: null,
    status: "unenrolled",
    registeredAt: "2026-09-01T10:00:00.000Z",
    firstFrameAt: null,
    costCenter: null,
  },
  credentials: [],
  roles: [],
  hosts: [],
  definition: null,
};
const beltOut = {
  agentId: "agt_releasebot",
  agentKey: null,
  computedAt: "2026-09-15T09:00:00.000Z",
  basis: {
    humanCeiling: "caller",
    roleGrants: 0,
    denyGeneration: { org: 0, workspace: 0 },
    killSwitches: 0,
  },
  presentation: { mode: "full", limit: 40, sentToModel: "definitions" },
  tools: [],
  cannotSee: [],
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("agents.list", () => {
  it("reads the newest page with no cursor, then a later page by its cursor", async () => {
    kernelRead.mockResolvedValue(readOk(listOut));
    const read = await agents.list(ctx, { cursor: null });
    expect(read.ok && read.value.agents.map((a) => a.id)).toEqual([
      "agt_releasebot",
    ]);
    await agents.list(ctx, { cursor: "c2" });
    expect(kernelRead.mock.calls).toEqual([
      [ctx, { contract: agentList, input: {}, page: "agents" }],
      [ctx, { contract: agentList, input: { cursor: "c2" }, page: "agents" }],
    ]);
  });

  it("passes a refused read through (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await agents.list(ctx, { cursor: null })).toEqual(DENIED);
  });

  it("answers record_unmappable and reports once for a row the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...listOut, items: [{ ...item, operatorId: "not an id" }] }),
    );
    expect(await agents.list(ctx, { cursor: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      orgId: ctx.orgId,
      context: "agents.list record_unmappable",
    });
  });
});

describe("agents.get", () => {
  it("reads get_agent by the agent the URL names", async () => {
    kernelRead.mockResolvedValue(readOk(getOut));
    const read = await agents.get(ctx, "release-bot");
    expect(read.ok && read.value.identity.slug).toBe("release-bot");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentGet,
      input: { agentId: "release-bot" },
      page: "agents",
    });
  });

  it("passes a refused read through and refuses an unmappable one (negative)", async () => {
    kernelRead.mockResolvedValueOnce(readError("not_found", 404));
    expect(await agents.get(ctx, "nobody")).toEqual(
      readError("not_found", 404),
    );
    kernelRead.mockResolvedValueOnce(
      readOk({ ...getOut, identity: { ...getOut.identity, id: "7" } }),
    );
    expect(await agents.get(ctx, "release-bot")).toEqual(
      readError("record_unmappable", 502),
    );
  });
});

describe("agents.toolbelt", () => {
  it("reads get_agent_toolbelt for the agent, leaving the presentation to the belt size", async () => {
    kernelRead.mockResolvedValue(readOk(beltOut));
    const read = await agents.toolbelt(ctx, "agt_releasebot");
    expect(read.ok && read.value.presentation.mode).toBe("full");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentToolbeltGet,
      input: { agentId: "agt_releasebot" },
      page: "agents",
    });
  });

  it("passes a refused read through and refuses an unmappable one (negative)", async () => {
    kernelRead.mockResolvedValueOnce(DENIED);
    expect(await agents.toolbelt(ctx, "agt_releasebot")).toEqual(DENIED);
    kernelRead.mockResolvedValueOnce(
      readOk({ ...beltOut, computedAt: "yesterday" }),
    );
    expect(await agents.toolbelt(ctx, "agt_releasebot")).toEqual(
      readError("record_unmappable", 502),
    );
  });
});

describe("agents.incidents", () => {
  const incident = {
    id: "tin_1",
    kind: "chain_break",
    severity: 10,
    detectedAt: "2026-09-14T10:00:00.000Z",
    detectedBy: "control_plane",
    hostEnrollmentId: null,
    sessionId: null,
    agentKey: null,
    evidence: {},
    resolvedAt: null,
    resolutionNote: null,
  };

  it("reads list_incidents narrowed to the agent, at the asked cursor", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [incident], nextCursor: null }),
    );
    const read = await agents.incidents(ctx, "agt_releasebot", {
      cursor: null,
    });
    expect(read.ok && read.value.incidents[0]?.severity).toBe("tamper");
    await agents.incidents(ctx, "agt_releasebot", { cursor: "c2" });
    expect(kernelRead.mock.calls).toEqual([
      [
        ctx,
        {
          contract: tachoIncidentList,
          input: { agentId: "agt_releasebot" },
          page: "agents",
        },
      ],
      [
        ctx,
        {
          contract: tachoIncidentList,
          input: { agentId: "agt_releasebot", cursor: "c2" },
          page: "agents",
        },
      ],
    ]);
  });

  it("passes a refused read through and refuses an unmappable one (negative)", async () => {
    kernelRead.mockResolvedValueOnce(
      readError("iam_principals_unavailable", 503),
    );
    expect(
      await agents.incidents(ctx, "agt_releasebot", { cursor: null }),
    ).toEqual(readError("iam_principals_unavailable", 503));
    kernelRead.mockResolvedValueOnce(
      readOk({ items: [{ ...incident, sessionId: "raw" }], nextCursor: null }),
    );
    expect(
      await agents.incidents(ctx, "agt_releasebot", { cursor: null }),
    ).toEqual(readError("record_unmappable", 502));
  });
});
