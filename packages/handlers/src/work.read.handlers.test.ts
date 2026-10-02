// The Work pages' read handlers over fakes (P1-05, #5163): list_work_items,
// get_work_item, list_work_targets, and get_work_outcomes.
//
// The role guard is a double, so each case asserts the handler asked it with
// its own contract before it read anything, and that a refused caller reads
// nothing. lib/work-read/read.pg.test.ts runs the reads on Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { WorkRecordError } from "@oxagen/work/records";

const mocks = vi.hoisted(() => ({ role: vi.fn() }));
vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));

import { workItemGet } from "@oxagen/oxagen/contracts/work.item.get";
import { workItemsList } from "@oxagen/oxagen/contracts/work.items.list";
import { workOutcomesGet, type WorkOutcomesGetOutput } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { workTargetsList } from "@oxagen/oxagen/contracts/work.targets.list";
import type { WorkItemDetail } from "./lib/work-read/detail";
import { createWorkItemGetHandler } from "./work.item.get";
import { createWorkItemsListHandler } from "./work.items.list";
import { createWorkOutcomesGetHandler } from "./work.outcomes.get";
import { createWorkTargetsListHandler } from "./work.targets.list";

const ctx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  apiKeyId: null,
} as unknown as CapabilityContext;
const SCOPE = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
const NOW = new Date("2026-10-02T12:00:00.000Z");
const VIEWER = { can_control: true, can_approve: false };

const refused = () => new HandlerError({ code: "forbidden", reason: "org_role_required", message: "Requires a role" });

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockResolvedValue("Viewer");
});

describe("list_work_items", () => {
  const deps = () => ({
    list: vi.fn(async () => ({ items: [], truncated: true })),
    viewer: vi.fn(async () => VIEWER),
  });

  it("checks the role, reads the page, and adds the viewer", async () => {
    const d = deps();
    const out = await createWorkItemsListHandler(d)({ limit: 50 }, ctx);
    expect(mocks.role).toHaveBeenCalledWith(workItemsList, ctx);
    expect(d.list).toHaveBeenCalledWith(SCOPE, 50);
    expect(d.viewer).toHaveBeenCalledWith(ctx);
    expect(out).toEqual({ items: [], truncated: true, viewer: VIEWER });
  });

  it("refuses a caller with no role before it reads anything", async () => {
    mocks.role.mockRejectedValue(refused());
    const d = deps();
    await expect(createWorkItemsListHandler(d)({ limit: 500 }, ctx)).rejects.toMatchObject({ code: "forbidden" });
    expect(d.list).not.toHaveBeenCalled();
    expect(d.viewer).not.toHaveBeenCalled();
  });
});

describe("get_work_item", () => {
  const DETAIL = { item: { id: "wi_01" }, sends: [] } as unknown as WorkItemDetail;
  const deps = (detail: WorkItemDetail | null = DETAIL) => ({
    read: vi.fn(async () => detail),
    viewer: vi.fn(async () => VIEWER),
  });

  it("checks the role, reads the item, and adds the viewer", async () => {
    const d = deps();
    const out = await createWorkItemGetHandler(d)({ item: "WI-1" }, ctx);
    expect(mocks.role).toHaveBeenCalledWith(workItemGet, ctx);
    expect(d.read).toHaveBeenCalledWith(SCOPE, "WI-1");
    expect(out).toEqual({ ...DETAIL, viewer: VIEWER });
  });

  it("answers not found for an item this workspace does not hold", async () => {
    const d = deps(null);
    await expect(createWorkItemGetHandler(d)({ item: "wi_elsewhere" }, ctx)).rejects.toMatchObject({
      code: "not_found",
      reason: "work_item_not_found",
    });
    expect(d.viewer).not.toHaveBeenCalled();
  });

  it("answers a damaged record as invalid input, not a server error", async () => {
    const d = deps();
    d.read.mockRejectedValue(new WorkRecordError("invalid_input", "A brief's schema must be work-brief/v1."));
    await expect(createWorkItemGetHandler(d)({ item: "WI-1" }, ctx)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a caller with no role before it reads anything", async () => {
    mocks.role.mockRejectedValue(refused());
    const d = deps();
    await expect(createWorkItemGetHandler(d)({ item: "WI-1" }, ctx)).rejects.toMatchObject({ code: "forbidden" });
    expect(d.read).not.toHaveBeenCalled();
    expect(d.viewer).not.toHaveBeenCalled();
  });
});

describe("list_work_targets", () => {
  const deps = () => ({
    list: vi.fn(async () => []),
    actingUser: vi.fn(async () => ctx.userId),
    now: () => NOW,
  });

  it("reads the targets for the person the call acts as", async () => {
    const d = deps();
    expect(await createWorkTargetsListHandler(d)({}, ctx)).toEqual({ agents: [] });
    expect(mocks.role).toHaveBeenCalledWith(workTargetsList, ctx);
    expect(d.actingUser).toHaveBeenCalledWith(ctx);
    expect(d.list).toHaveBeenCalledWith(SCOPE, ctx.userId, NOW);
  });

  it("refuses a caller with no role before it reads anything", async () => {
    mocks.role.mockRejectedValue(refused());
    const d = deps();
    await expect(createWorkTargetsListHandler(d)({}, ctx)).rejects.toMatchObject({ code: "forbidden" });
    expect(d.actingUser).not.toHaveBeenCalled();
    expect(d.list).not.toHaveBeenCalled();
  });
});

describe("get_work_outcomes", () => {
  const OUTCOMES = { days: 30 } as unknown as WorkOutcomesGetOutput;
  const deps = () => ({ read: vi.fn(async () => OUTCOMES), now: () => NOW });

  it("counts the window the caller asked for, up to now", async () => {
    const d = deps();
    expect(await createWorkOutcomesGetHandler(d)({ days: 14 }, ctx)).toBe(OUTCOMES);
    expect(mocks.role).toHaveBeenCalledWith(workOutcomesGet, ctx);
    expect(d.read).toHaveBeenCalledWith(SCOPE, 14, NOW);
  });

  it("refuses a caller with no role before it reads anything", async () => {
    mocks.role.mockRejectedValue(refused());
    const d = deps();
    await expect(createWorkOutcomesGetHandler(d)({ days: 30 }, ctx)).rejects.toMatchObject({ code: "forbidden" });
    expect(d.read).not.toHaveBeenCalled();
  });
});
