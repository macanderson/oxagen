// The person gate on every work action (ADR-251): a decision on a work item is
// a signed-in person's, never an API key's or an agent run's, and the person
// needs a role the action takes in this workspace. The gate runs before any
// database work, so a refused caller reads nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { type WorkItemAction, workActionRoles } from "@oxagen/work/records";
import { workBriefApprove } from "@oxagen/oxagen/contracts/work.brief.approve";
import { workBriefSave } from "@oxagen/oxagen/contracts/work.brief.save";
import { workItemClose } from "@oxagen/oxagen/contracts/work.item.close";
import { workItemReopen } from "@oxagen/oxagen/contracts/work.item.reopen";
import { workOrderAccept } from "@oxagen/oxagen/contracts/work.order.accept";
import { workOrderCancel } from "@oxagen/oxagen/contracts/work.order.cancel";
import { workOrderChecksRefresh } from "@oxagen/oxagen/contracts/work.order.checks.refresh";
import { workOrderReturn } from "@oxagen/oxagen/contracts/work.order.return";
import { workOrderSend } from "@oxagen/oxagen/contracts/work.order.send";
import { workOrderStop } from "@oxagen/oxagen/contracts/work.order.stop";

const mocks = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(async (ctx: { userId: string | null }) => ctx.userId),
}));
vi.mock("@oxagen/iam/org-role", () => ({ assertOrgRole: mocks.assertOrgRole, resolveActingUserId: mocks.resolveActingUserId }));

import { createWorkBriefApproveHandler } from "./work.brief.approve";
import { createWorkBriefSaveHandler } from "./work.brief.save";
import { createWorkItemCloseHandler } from "./work.item.close";
import { createWorkItemReopenHandler } from "./work.item.reopen";
import { createWorkOrderAcceptHandler } from "./work.order.accept";
import { createWorkOrderCancelHandler } from "./work.order.cancel";
import { createWorkOrderChecksRefreshHandler } from "./work.order.checks.refresh";
import { createWorkOrderReturnHandler } from "./work.order.return";
import { createWorkOrderSendHandler } from "./work.order.send";
import { createWorkOrderStopHandler } from "./work.order.stop";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const person: CapabilityContext = { orgId: ORG, workspaceId: WS, userId: "user_1", apiKeyId: null, requestId: "r", surface: "app", messageId: null };
const apiKey: CapabilityContext = { ...person, userId: null, apiKeyId: "aky_1", surface: "api" };
/** An `oxagen login` key: the API sets both the key and the person it resolves to. */
const cliKey: CapabilityContext = { ...person, apiKeyId: "aky_cli", surface: "api" };
const agentRun = { ...person, agentRun: { principalKind: "agent" } } as unknown as CapabilityContext;

/** What the fake transaction throws: the gate passed and the handler reached the database. */
const REACHED_DB = "the gate must refuse before any database work";
const DIGEST = `sha256:${"a".repeat(64)}`;

const SEND = workOrderSend.input.parse({
  item_id: "wi_abc",
  version: 4,
  item_revision: 1,
  brief_revision: 1,
  brief_digest: DIGEST,
  agent_id: "agt_xyz",
  key: "wi_abc:r1:s1",
});

const ACCEPT = workOrderAccept.input.parse({
  item_id: "wi_abc",
  version: 9,
  work_order_id: "wo_1",
  head_sha: "1".repeat(40),
  brief_digest: DIGEST,
  criteria: ["c1"],
});

const SAVE = workBriefSave.input.parse({
  item_id: "wi_abc",
  version: 3,
  item_revision: 1,
  repository: "acme/platform",
  criteria: [{ text: "The settings page saves the new name.", tag: "code", intent: "check", provenance: "person" }],
});

const APPROVE = workBriefApprove.input.parse({ item_id: "wi_abc", version: 1, item_revision: 1, brief_revision: 1, brief_digest: DIGEST });
const CLOSE = workItemClose.input.parse({ item_id: "wi_abc", version: 5, resolution: "declined", reason: "Not planned." });
const REOPEN = workItemReopen.input.parse({ item_id: "wi_abc", version: 6, reason: "The bug came back." });
const CANCEL = workOrderCancel.input.parse({ item_id: "wi_abc", version: 5, work_order_id: "wo_1", reason: "Wrong agent." });
const STOP = workOrderStop.input.parse({ item_id: "wi_abc", version: 7, work_order_id: "wo_1", reason: "It ran too long." });
const RETURN = workOrderReturn.input.parse({ item_id: "wi_abc", version: 8, work_order_id: "wo_1", reason: "The test still fails." });
const REFRESH = workOrderChecksRefresh.input.parse({ item_id: "wi_abc", work_order_id: "wo_1" });

function deps() {
  return {
    db: vi.fn(async () => {
      throw new Error(REACHED_DB);
    }),
    governanceMode: vi.fn(async () => null),
    reader: { readPullRequest: vi.fn(), readRequiredChecks: vi.fn(), readChecks: vi.fn() },
    now: () => new Date("2026-10-02T10:00:00Z"),
  };
}

type Deps = ReturnType<typeof deps>;
type Decision = [name: string, action: WorkItemAction, run: (d: Deps, ctx: CapabilityContext) => Promise<unknown>];

/**
 * Every decision handler, with the action whose roles it checks. Read checks
 * takes the roles Accept takes (work.order.checks.refresh.ts).
 */
const DECISIONS: Decision[] = [
  ["save_work_brief", "save_brief", (d, ctx) => createWorkBriefSaveHandler(d)(SAVE, ctx)],
  ["approve_work_brief", "approve_brief", (d, ctx) => createWorkBriefApproveHandler(d)(APPROVE, ctx)],
  ["send_work_order", "send", (d, ctx) => createWorkOrderSendHandler(d)(SEND, ctx)],
  ["cancel_work_order", "withdraw", (d, ctx) => createWorkOrderCancelHandler(d)(CANCEL, ctx)],
  ["stop_work_order", "stop", (d, ctx) => createWorkOrderStopHandler(d)(STOP, ctx)],
  ["return_work_order", "return", (d, ctx) => createWorkOrderReturnHandler(d)(RETURN, ctx)],
  ["accept_work_order", "accept", (d, ctx) => createWorkOrderAcceptHandler(d)(ACCEPT, ctx)],
  ["refresh_work_order_checks", "accept", (d, ctx) => createWorkOrderChecksRefreshHandler(d)(REFRESH, ctx)],
  ["close_work_item", "close", (d, ctx) => createWorkItemCloseHandler(d)(CLOSE, ctx)],
  ["reopen_work_item", "reopen", (d, ctx) => createWorkItemReopenHandler(d)(REOPEN, ctx)],
];

/** Nothing past the gate ran: no role check, no database, no GitHub read. */
function expectNothingRead(d: Deps): void {
  expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  expect(d.db).not.toHaveBeenCalled();
  expect(d.governanceMode).not.toHaveBeenCalled();
  expect(d.reader.readPullRequest).not.toHaveBeenCalled();
  expect(d.reader.readRequiredChecks).not.toHaveBeenCalled();
  expect(d.reader.readChecks).not.toHaveBeenCalled();
}

beforeEach(() => {
  mocks.assertOrgRole.mockReset();
  mocks.assertOrgRole.mockResolvedValue("Member");
});

describe("the person gate on every work decision", () => {
  it("covers each decision handler once", () => {
    expect(new Set(DECISIONS.map(([name]) => name)).size).toBe(10);
  });

  it.each(DECISIONS)("%s refuses an API key before it reads anything", async (_name, _action, run) => {
    const d = deps();
    await expect(run(d, apiKey)).rejects.toMatchObject({ code: "forbidden", reason: "person_required" });
    expect(mocks.resolveActingUserId).not.toHaveBeenCalled();
    expectNothingRead(d);
  });

  it.each(DECISIONS)("%s refuses a CLI login key even though it resolves to a person", async (_name, _action, run) => {
    const d = deps();
    await expect(run(d, cliKey)).rejects.toMatchObject({ code: "forbidden", reason: "person_required" });
    expect(mocks.resolveActingUserId).not.toHaveBeenCalled();
    expectNothingRead(d);
  });

  it.each(DECISIONS)("%s refuses an agent run, so an agent cannot decide its own work", async (_name, _action, run) => {
    const d = deps();
    await expect(run(d, agentRun)).rejects.toMatchObject({ code: "forbidden", reason: "agent_run" });
    expect(mocks.resolveActingUserId).not.toHaveBeenCalled();
    expectNothingRead(d);
  });

  it.each(DECISIONS)("%s checks the roles that %s takes, on the call's own org and workspace", async (_name, action, run) => {
    const d = deps();
    await expect(run(d, person)).rejects.toThrow(REACHED_DB);
    expect(mocks.assertOrgRole).toHaveBeenCalledTimes(1);
    expect(mocks.assertOrgRole).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS, userId: "user_1" }, workActionRoles(action));
  });

  it.each(DECISIONS)("%s stops at a refused role", async (_name, _action, run) => {
    mocks.assertOrgRole.mockRejectedValueOnce(Object.assign(new Error("no role"), { code: "forbidden", reason: "org_role_required" }));
    const d = deps();
    await expect(run(d, person)).rejects.toMatchObject({ reason: "org_role_required" });
    expect(d.db).not.toHaveBeenCalled();
    expect(d.governanceMode).not.toHaveBeenCalled();
  });
});

describe("the governance mode", () => {
  it("is read before the send transaction opens", async () => {
    const d = deps();
    const order: string[] = [];
    d.governanceMode.mockImplementation(async () => {
      order.push("governance");
      return "regulated" as never;
    });
    d.db.mockImplementation(async () => {
      order.push("db");
      throw new Error("stop here");
    });
    await expect(createWorkOrderSendHandler(d)(SEND, person)).rejects.toThrow("stop here");
    expect(order).toEqual(["governance", "db"]);
  });

  it("is read for a return only when the return sends the item again", async () => {
    const keep = deps();
    await expect(createWorkOrderReturnHandler(keep)({ ...RETURN, resend: false }, person)).rejects.toThrow(REACHED_DB);
    expect(keep.governanceMode).not.toHaveBeenCalled();
    expect(keep.db).toHaveBeenCalledTimes(1);

    const again = deps();
    await expect(createWorkOrderReturnHandler(again)({ ...RETURN, resend: true }, person)).rejects.toThrow(REACHED_DB);
    expect(again.governanceMode).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS });
    expect(again.db).toHaveBeenCalledTimes(1);
  });
});
