// The work port: each Work read through the kernel seam, mapped into its view
// model. A record the view refuses answers record_unmappable 502 and is
// reported once, never drawn as part of a page. The collectors still draw
// when the linked repositories cannot be read: Add collector then saves
// nothing and says why.
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { workCollectorsList } from "@oxagen/oxagen/contracts/work.collectors.list";
import { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
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
const { work } = await import("./work");

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

const AT = "2026-10-02T12:00:00.000Z";

/** list_work_collectors' answer: one healthy GitHub collector, and a Member who cannot change it. */
const COLLECTORS = {
  collectors: [
    {
      collector_id: "00000000-0000-4000-8000-0000000000c1",
      name: "github",
      type: "github",
      connection_id: "con_01k6github",
      repos: ["acme/platform"],
      health: "healthy",
      cursor: null,
      last_reconcile: null,
      last_success_at: AT,
      failed_streak: 0,
      next_check_at: AT,
      last_event_at: null,
      created_at: AT,
    },
  ],
  viewer: { can_change_collectors: false },
};

/** list_repositories' answer: one GitHub repository and one GitLab project. */
const REPOSITORIES = {
  repositories: [
    {
      bindingId: "rpb_0a1b2c3d",
      role: "main",
      provider: "github",
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      defaultRef: "main",
      htmlUrl: "https://github.com/acme/platform",
      boundAt: AT,
      connectionLive: true,
      events: "installed",
    },
    {
      bindingId: "rpb_0a1b2c3e",
      role: "linked",
      provider: "gitlab",
      owner: "acme",
      name: "docs",
      fullName: "acme/docs",
      defaultRef: "main",
      htmlUrl: "https://gitlab.com/acme/docs",
      boundAt: AT,
      connectionLive: true,
      events: "unknown",
    },
  ],
};

/** get_work_outcomes' answer for a window with nothing in it. */
const OUTCOMES = {
  days: 30,
  since: "2026-09-02T12:00:00.000Z",
  accepted_merged: 0,
  returned: 0,
  closed: { cancelled: 0, declined: 0, duplicate: 0 },
  lead_time: { median_hours: null, p90_hours: null, sample: 0 },
  touches: { per_item: null, brief_approvals: 0, acceptances: 0, returns: 0, triage_overrides: 0, triage_corrections: 0 },
  cost: { runs: 0, known_runs: 0, total: null },
  reopens: { cohort: 0, reopened: 0, waiting: 0 },
  delivery: {
    sends: 0,
    claimed: 0,
    rejected: 0,
    withdrawn: 0,
    waiting: 0,
    claim_minutes: { median: null, p90: null, sample: 0 },
    truncated: false,
  },
  truncated: false,
  weeks: [
    { week: "2026-09-28", accepted_merged: 0, returned: 0, median_lead_hours: null, entered: 0, sent: 0, full_flow: false, complete: false },
  ],
};

/** Answer each read by its contract, the way the kernel seam would. */
function answer(byContract: Map<unknown, unknown>) {
  kernelRead.mockImplementation((_ctx: unknown, read: { contract: unknown }) =>
    Promise.resolve(byContract.get(read.contract) ?? readError("not_expected", 500)),
  );
}

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("work.collectors", () => {
  it("reads the collectors with the linked GitHub repositories and the viewer's flag", async () => {
    answer(
      new Map<unknown, unknown>([
        [workCollectorsList, readOk(COLLECTORS)],
        [repositoryList, readOk(REPOSITORIES)],
      ]),
    );
    const read = await work.collectors(ctx);
    if (!read.ok) throw new Error(`the read failed: ${read.reason}`);
    expect(read.value.linked).toEqual(["acme/platform"]);
    expect(read.value.viewer).toEqual({ canChangeCollectors: false });
    expect(read.value.collectors.map((collector) => collector.name)).toEqual(["github"]);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("draws the collectors when the repositories read fails, with no linked repositories (negative)", async () => {
    answer(
      new Map<unknown, unknown>([
        [workCollectorsList, readOk(COLLECTORS)],
        [repositoryList, readError("repositories_unavailable", 503)],
      ]),
    );
    const read = await work.collectors(ctx);
    if (!read.ok) throw new Error(`the read failed: ${read.reason}`);
    expect(read.value.linked).toBeNull();
    expect(read.value.collectors).toHaveLength(1);
    expect(read.value.collectors[0]).toMatchObject({ name: "github", health: "healthy", repos: ["acme/platform"] });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a refused collectors read through, whatever the repositories read said (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "run.read" };
    answer(
      new Map<unknown, unknown>([
        [workCollectorsList, denied],
        [repositoryList, readOk(REPOSITORIES)],
      ]),
    );
    expect(await work.collectors(ctx)).toEqual(denied);
  });

  it("answers record_unmappable 502 and reports once for a collector the view refuses (negative)", async () => {
    answer(
      new Map<unknown, unknown>([
        [workCollectorsList, readOk({ ...COLLECTORS, collectors: [{ ...COLLECTORS.collectors[0], created_at: "yesterday" }] })],
        [repositoryList, readOk(REPOSITORIES)],
      ]),
    );
    expect(await work.collectors(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ctx.orgId, context: "work.collectors record_unmappable" }),
    );
  });
});

describe("work.outcomes", () => {
  it("reads 30 days and maps the figures, each week saying whether it is whole", async () => {
    answer(new Map<unknown, unknown>([[workOutcomesGet, readOk(OUTCOMES)]]));
    const read = await work.outcomes(ctx);
    expect(kernelRead).toHaveBeenCalledWith(ctx, { contract: workOutcomesGet, input: { days: 30 }, page: "work" });
    if (!read.ok) throw new Error(`the read failed: ${read.reason}`);
    expect(read.value.weeks).toEqual([
      { week: "2026-09-28", acceptedMerged: 0, returned: 0, medianLeadHours: null, complete: false },
    ]);
  });

  it("answers record_unmappable 502 and reports once for a figure the view refuses (negative)", async () => {
    answer(new Map<unknown, unknown>([[workOutcomesGet, readOk({ ...OUTCOMES, since: "last month" })]]));
    expect(await work.outcomes(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ctx.orgId, context: "work.outcomes record_unmappable" }),
    );
  });
});
