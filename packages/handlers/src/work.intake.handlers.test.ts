// The work intake and triage handlers over fakes (P1-03, #5103):
// create_work_item, revise_work_triage, retry_work_triage,
// list_work_collectors, set_work_collector, sync_work_collector, and
// get_work_priorities.
//
// The role guard is a double, so each case asserts the handler asked it with
// its own contract before it read or wrote anything. The stores are fakes;
// lib/work-intake/work-intake.pg.test.ts runs the same paths on Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { WorkRecordError } from "@oxagen/work/records";

const mocks = vi.hoisted(() => ({ role: vi.fn() }));
vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));

import { workCollectorSet } from "@oxagen/oxagen/contracts/work.collector.set";
import { workCollectorSync } from "@oxagen/oxagen/contracts/work.collector.sync";
import { workCollectorsList } from "@oxagen/oxagen/contracts/work.collectors.list";
import { workItemCreate } from "@oxagen/oxagen/contracts/work.item.create";
import { workPrioritiesGet } from "@oxagen/oxagen/contracts/work.priorities.get";
import { workTriageRetry } from "@oxagen/oxagen/contracts/work.triage.retry";
import { workTriageRevise } from "@oxagen/oxagen/contracts/work.triage.revise";
import { effectiveTriage } from "@oxagen/work";
import type { CollectorView } from "./lib/work-intake/collectors";
import { CollectorSetupError } from "./lib/work-intake/collectors";
import { createWorkCollectorSetHandler } from "./work.collector.set";
import { createWorkCollectorSyncHandler } from "./work.collector.sync";
import { createWorkCollectorsListHandler } from "./work.collectors.list";
import { createWorkItemCreateHandler } from "./work.item.create";
import { createWorkPrioritiesGetHandler } from "./work.priorities.get";
import { createWorkTriageRetryHandler } from "./work.triage.retry";
import { createWorkTriageReviseHandler, triageViewOutput } from "./work.triage.revise";

const ctx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  apiKeyId: null,
} as unknown as CapabilityContext;
const SCOPE = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
const ACTOR = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-10-02T12:00:00.000Z");
const COLLECTOR_ID = "00000000-0000-4000-8000-0000000000c1";

const VIEW: CollectorView = {
  collector_id: COLLECTOR_ID,
  name: "github",
  type: "github",
  connection_id: "con_01",
  repos: ["acme/web"],
  health: "healthy",
  cursor: null,
  last_reconcile: null,
  last_success_at: null,
  failed_streak: 0,
  next_check_at: "2026-10-02T12:15:00.000Z",
  last_event_at: null,
  created_at: "2026-10-02T12:00:00.000Z",
};

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockResolvedValue(ACTOR);
});

describe("create_work_item", () => {
  it("enters the item as the caller and queues triage", async () => {
    const enter = vi.fn(async () => ({ id: "row-1", publicId: "wi_01", number: "WI-4", state: "new" as const, revision: 1, version: 1 }));
    const send = vi.fn(async () => undefined);
    const out = await createWorkItemCreateHandler({ enter, send })(
      { subject: "Fix invites", labels: ["Bug"], repository: "acme/web" },
      ctx,
    );
    expect(mocks.role).toHaveBeenCalledWith(workItemCreate, ctx);
    expect(enter).toHaveBeenCalledWith(SCOPE, {
      subject: "Fix invites",
      description: null,
      labels: ["Bug"],
      repository: "acme/web",
      actorUserId: ACTOR,
    });
    expect(send).toHaveBeenCalledWith([
      {
        name: "work/item.received",
        id: "work-item-wi_01-new",
        data: { org_id: SCOPE.orgId, workspace_id: SCOPE.workspaceId, item_id: "wi_01", change: "new" },
      },
    ]);
    expect(out).toEqual({ item_id: "wi_01", number: "WI-4", state: "new", revision: 1, version: 1 });
  });

  it("refuses before it writes when the role guard refuses", async () => {
    mocks.role.mockRejectedValue(new Error("forbidden"));
    const enter = vi.fn();
    await expect(createWorkItemCreateHandler({ enter, send: vi.fn() })({ subject: "x", labels: [] }, ctx)).rejects.toThrow("forbidden");
    expect(enter).not.toHaveBeenCalled();
  });

  it("answers an empty subject as invalid input", async () => {
    const enter = vi.fn(async () => {
      throw new WorkRecordError("invalid_input", "The subject is empty once its control characters are removed.");
    });
    await expect(createWorkItemCreateHandler({ enter, send: vi.fn() })({ subject: "\u0000", labels: [] }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("revise_work_triage", () => {
  const view = effectiveTriage(null, null, []);
  const result = {
    item: { id: "row-1", publicId: "wi_01", number: "WI-1" },
    version: 5,
    state: "triaged" as const,
    changed: ["priority" as const],
    view,
    standing: { outcome: "triaged" as const, by: "oxagen" as const, decision: "tri_1", duplicateOf: null },
  };

  it("passes only the fields the caller named, and the outcome and duplicate", async () => {
    const revise = vi.fn(async () => result);
    const out = await createWorkTriageReviseHandler({ revise })(
      {
        item_id: "wi_01",
        expected_version: 4,
        reason: "Customer",
        priority: "P0",
        labels: null,
        outcome: "duplicate",
        duplicate_of: "wi_02",
      },
      ctx,
    );
    expect(mocks.role).toHaveBeenCalledWith(workTriageRevise, ctx);
    expect(revise).toHaveBeenCalledWith(SCOPE, {
      itemPublicId: "wi_01",
      expectedVersion: 4,
      reason: "Customer",
      fields: { priority: "P0", labels: null },
      outcome: "duplicate",
      duplicateOf: "wi_02",
      actorUserId: ACTOR,
    });
    expect(out).toEqual({
      item_id: "wi_01",
      version: 5,
      state: "triaged",
      changed: ["priority"],
      triage: triageViewOutput(view),
      standing: { outcome: "triaged", by: "oxagen", duplicate_of: null },
    });
  });

  it("passes every field it was given", async () => {
    const revise = vi.fn(async () => result);
    await createWorkTriageReviseHandler({ revise })(
      { item_id: "wi_01", expected_version: 4, reason: "r", estimate_minutes: 30, claims: ["a/**"], criteria: ["c"] },
      ctx,
    );
    expect(revise).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ fields: { estimate_minutes: 30, claims: ["a/**"], criteria: ["c"] } }));
  });

  it("refuses a request that changes nothing before it reads the item", async () => {
    const revise = vi.fn();
    await expect(createWorkTriageReviseHandler({ revise })({ item_id: "wi_01", expected_version: 4, reason: "r" }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(revise).not.toHaveBeenCalled();
  });

  it("answers a stale version as a conflict", async () => {
    const revise = vi.fn(async () => {
      throw new WorkRecordError("stale_version", "Read it again.");
    });
    await expect(
      createWorkTriageReviseHandler({ revise })({ item_id: "wi_01", expected_version: 1, reason: "r", priority: "P1" }, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "stale_version" });
  });
});

describe("retry_work_triage", () => {
  it("queues a fresh triage run for an item triage may change", async () => {
    const send = vi.fn(async () => undefined);
    const out = await createWorkTriageRetryHandler({ state: async () => ({ state: "new" }), send, now: () => NOW })({ item_id: "wi_01" }, ctx);
    expect(mocks.role).toHaveBeenCalledWith(workTriageRetry, ctx);
    expect(send).toHaveBeenCalledWith([
      {
        name: "work/item.received",
        id: `work-item-wi_01-retry-${NOW.getTime()}`,
        data: { org_id: SCOPE.orgId, workspace_id: SCOPE.workspaceId, item_id: "wi_01", change: "retry" },
      },
    ]);
    expect(out).toEqual({ item_id: "wi_01", state: "new", queued: true });
  });

  it("refuses an item the workspace does not hold, and one past triage", async () => {
    const send = vi.fn();
    await expect(
      createWorkTriageRetryHandler({ state: async () => null, send, now: () => NOW })({ item_id: "wi_09" }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createWorkTriageRetryHandler({ state: async () => ({ state: "sent" }), send, now: () => NOW })({ item_id: "wi_01" }, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "not_allowed" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("list_work_collectors", () => {
  it("lists the workspace's collectors after the role check", async () => {
    const list = vi.fn(async () => [VIEW]);
    expect(await createWorkCollectorsListHandler({ list })({}, ctx)).toEqual({ collectors: [VIEW] });
    expect(mocks.role).toHaveBeenCalledWith(workCollectorsList, ctx);
    expect(list).toHaveBeenCalledWith(SCOPE);
  });
});

describe("set_work_collector", () => {
  it("writes the collector and queues a reconcile when it should read now", async () => {
    const set = vi.fn(async () => ({ result: { collectorId: COLLECTOR_ID, created: true, reconcile: true }, view: VIEW }));
    const send = vi.fn(async () => undefined);
    const out = await createWorkCollectorSetHandler({ set, send, now: () => NOW })(
      { name: "github", connection_id: "con_01", repos: ["acme/web"] },
      ctx,
    );
    expect(mocks.role).toHaveBeenCalledWith(workCollectorSet, ctx);
    expect(set).toHaveBeenCalledWith(SCOPE, { name: "github", connectionId: "con_01", repos: ["acme/web"], actorUserId: ACTOR });
    expect(send).toHaveBeenCalledWith([
      {
        name: "work/collector.check.requested",
        id: `work-check-set-${COLLECTOR_ID}-${NOW.getTime()}`,
        data: { org_id: SCOPE.orgId, workspace_id: SCOPE.workspaceId, collector_id: COLLECTOR_ID, check: "reconcile", force: true },
      },
    ]);
    expect(out).toEqual({ collector: VIEW, created: true, reconcile_queued: true });
  });

  it("queues nothing for a pause, and answers a setup refusal", async () => {
    const send = vi.fn();
    const paused = vi.fn(async () => ({ result: { collectorId: COLLECTOR_ID, created: false, reconcile: false }, view: { ...VIEW, health: "paused" as const } }));
    const out = await createWorkCollectorSetHandler({ set: paused, send, now: () => NOW })({ name: "github", paused: true }, ctx);
    expect(paused).toHaveBeenCalledWith(SCOPE, { name: "github", paused: true, actorUserId: ACTOR });
    expect(out.reconcile_queued).toBe(false);
    expect(send).not.toHaveBeenCalled();

    const refused = vi.fn(async () => {
      throw new CollectorSetupError("not_found", "This workspace has no GitHub connection con_09.");
    });
    await expect(
      createWorkCollectorSetHandler({ set: refused, send, now: () => NOW })({ name: "github", connection_id: "con_09", repos: ["a/b"] }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("sync_work_collector", () => {
  it("queues a forced reconcile of a collector the workspace holds", async () => {
    const send = vi.fn(async () => undefined);
    const find = vi.fn(async () => ({ id: COLLECTOR_ID, health: "failing" }));
    const out = await createWorkCollectorSyncHandler({ find, send, now: () => NOW })({ collector_id: COLLECTOR_ID }, ctx);
    expect(find).toHaveBeenCalledWith(SCOPE, { id: COLLECTOR_ID });
    expect(mocks.role).toHaveBeenCalledWith(workCollectorSync, ctx);
    expect(send).toHaveBeenCalledWith([
      {
        name: "work/collector.check.requested",
        id: `work-check-sync-${COLLECTOR_ID}-${NOW.getTime()}`,
        data: { org_id: SCOPE.orgId, workspace_id: SCOPE.workspaceId, collector_id: COLLECTOR_ID, check: "reconcile", force: true },
      },
    ]);
    expect(out).toEqual({ collector_id: COLLECTOR_ID, queued: true });
  });

  it("finds the collector by its name and queues the reconcile under its row id", async () => {
    const send = vi.fn(async () => undefined);
    const find = vi.fn(async () => ({ id: COLLECTOR_ID, health: "failing" }));
    const out = await createWorkCollectorSyncHandler({ find, send, now: () => NOW })({ name: "github" }, ctx);
    expect(find).toHaveBeenCalledWith(SCOPE, { name: "github" });
    expect(out).toEqual({ collector_id: COLLECTOR_ID, queued: true });
  });

  it("refuses a call that names no collector, or names one twice", async () => {
    const send = vi.fn();
    const find = vi.fn();
    const handler = createWorkCollectorSyncHandler({ find, send, now: () => NOW });
    await expect(handler({}, ctx)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(handler({ collector_id: COLLECTOR_ID, name: "github" }, ctx)).rejects.toMatchObject({ code: "invalid_input" });
    expect(find).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a collector the workspace does not hold, and a paused one", async () => {
    const send = vi.fn();
    await expect(
      createWorkCollectorSyncHandler({ find: async () => null, send, now: () => NOW })({ collector_id: COLLECTOR_ID }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createWorkCollectorSyncHandler({ find: async () => ({ id: COLLECTOR_ID, health: "paused" }), send, now: () => NOW })({ collector_id: COLLECTOR_ID }, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "collector_paused" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("get_work_priorities", () => {
  it("answers the record triage reads, as the contract spells it", async () => {
    const summary = vi.fn(async () => ({
      record: {
        lineage: "aintel.work.priorities",
        recordId: "ctr_01",
        version: 7,
        hash: `sha256:${"b".repeat(64)}`,
        rules: [{ number: 1, text: "A security hole is P0." }],
        publishedAt: null,
      },
      problem: null,
      last30Days: { suggestions: 3, failures: 0, corrections: 1 },
    }));
    const out = await createWorkPrioritiesGetHandler({ summary })({}, ctx);
    expect(mocks.role).toHaveBeenCalledWith(workPrioritiesGet, ctx);
    expect(out).toEqual({
      record: {
        lineage: "aintel.work.priorities",
        record_id: "ctr_01",
        version: 7,
        hash: `sha256:${"b".repeat(64)}`,
        rules: [{ number: 1, text: "A security hole is P0." }],
        published_at: null,
      },
      problem: null,
      last_30_days: { suggestions: 3, failures: 0, corrections: 1 },
    });
  });

  it("answers no record with the problem", async () => {
    const summary = vi.fn(async () => ({ record: null, problem: "No record.", last30Days: { suggestions: 0, failures: 0, corrections: 0 } }));
    expect(await createWorkPrioritiesGetHandler({ summary })({}, ctx)).toMatchObject({ record: null, problem: "No record." });
  });
});
