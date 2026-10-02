// The person gate on every work action (ADR-251): a decision on a work item is
// a signed-in person's, never an API key's or an agent run's, and the person
// needs a role the action takes in this workspace. The gate runs before any
// database work, so a refused caller reads nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { workActionRoles } from "@oxagen/work/records";
import { workOrderSend } from "@oxagen/oxagen/contracts/work.order.send";
import { workOrderAccept } from "@oxagen/oxagen/contracts/work.order.accept";
import { workBriefApprove } from "@oxagen/oxagen/contracts/work.brief.approve";

const mocks = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(async (ctx: { userId: string | null }) => ctx.userId),
}));
vi.mock("@oxagen/iam/org-role", () => ({ assertOrgRole: mocks.assertOrgRole, resolveActingUserId: mocks.resolveActingUserId }));

import { createWorkOrderSendHandler } from "./work.order.send";
import { createWorkOrderAcceptHandler } from "./work.order.accept";
import { createWorkBriefApproveHandler } from "./work.brief.approve";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const person: CapabilityContext = { orgId: ORG, workspaceId: WS, userId: "user_1", apiKeyId: null, requestId: "r", surface: "app", messageId: null };
const apiKey: CapabilityContext = { ...person, userId: null, apiKeyId: "aky_1", surface: "api" };
const agentRun = { ...person, agentRun: { principalKind: "agent" } } as unknown as CapabilityContext;

const SEND = workOrderSend.input.parse({
  item_id: "wi_abc",
  version: 4,
  item_revision: 1,
  brief_revision: 1,
  brief_digest: `sha256:${"a".repeat(64)}`,
  agent_id: "agt_xyz",
  key: "wi_abc:r1:s1",
});

const ACCEPT = workOrderAccept.input.parse({
  item_id: "wi_abc",
  version: 9,
  work_order_id: "wo_1",
  head_sha: "1".repeat(40),
  brief_digest: `sha256:${"a".repeat(64)}`,
  criteria: ["c1"],
});

function deps() {
  return {
    db: vi.fn(async () => {
      throw new Error("the gate must refuse before any database work");
    }),
    governanceMode: vi.fn(async () => null),
    reader: { readPullRequest: vi.fn(), readRequiredChecks: vi.fn(), readChecks: vi.fn() },
    now: () => new Date("2026-10-02T10:00:00Z"),
  };
}

beforeEach(() => {
  mocks.assertOrgRole.mockReset();
  mocks.assertOrgRole.mockResolvedValue("Member");
});

describe("the person gate on work actions", () => {
  it("refuses an API key before it reads anything", async () => {
    const d = deps();
    await expect(createWorkOrderSendHandler(d)(SEND, apiKey)).rejects.toMatchObject({ code: "forbidden", reason: "person_required" });
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
    expect(mocks.resolveActingUserId).not.toHaveBeenCalled();
    expect(d.db).not.toHaveBeenCalled();
    expect(d.governanceMode).not.toHaveBeenCalled();
  });

  it("refuses a CLI login key even though it resolves to a person", async () => {
    const d = deps();
    const cliKey: CapabilityContext = { ...person, apiKeyId: "aky_cli", surface: "api" };
    await expect(createWorkOrderAcceptHandler(d)(ACCEPT, cliKey)).rejects.toMatchObject({ code: "forbidden", reason: "person_required" });
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
    expect(d.db).not.toHaveBeenCalled();
  });

  it("refuses an agent run, so an agent cannot accept its own work", async () => {
    const d = deps();
    await expect(createWorkOrderAcceptHandler(d)(ACCEPT, agentRun)).rejects.toMatchObject({ code: "forbidden", reason: "agent_run" });
    expect(d.db).not.toHaveBeenCalled();
    expect(d.reader.readPullRequest).not.toHaveBeenCalled();
  });

  it("checks the roles the action takes, on the call's own org and workspace", async () => {
    const d = deps();
    await expect(createWorkOrderSendHandler(d)(SEND, person)).rejects.toThrow("the gate must refuse before any database work");
    expect(mocks.assertOrgRole).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS, userId: "user_1" }, workActionRoles("send"));

    mocks.assertOrgRole.mockClear();
    const approve = workBriefApprove.input.parse({ item_id: "wi_abc", version: 1, item_revision: 1, brief_revision: 1, brief_digest: `sha256:${"a".repeat(64)}` });
    await expect(createWorkBriefApproveHandler(deps())(approve, person)).rejects.toThrow();
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(expect.anything(), workActionRoles("approve_brief"));
  });

  it("stops at a refused role", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(Object.assign(new Error("no role"), { code: "forbidden", reason: "org_role_required" }));
    const d = deps();
    await expect(createWorkOrderAcceptHandler(d)(ACCEPT, person)).rejects.toMatchObject({ reason: "org_role_required" });
    expect(d.db).not.toHaveBeenCalled();
  });

  it("reads the governance mode before it opens the send transaction", async () => {
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
});
