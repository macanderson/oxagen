// `claim_work_order` (ADR-251): the host key is checked before anything reads
// the order, the resolved host is what the claim is checked against, and a
// work record refusal reaches the API as a refusal, never a 500. The claim's
// own rules (target host, one claimant, ended send) run against Postgres in
// lib/work-records/dispatch.pg.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@oxagen/database";
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { WorkRecordError } from "@oxagen/work/records";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  role: vi.fn(),
  claim: vi.fn(),
}));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolve }));
vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));
vi.mock("./lib/work-records/runtime", () => ({ claimWorkOrder: mocks.claim }));

import { workOrderClaim as contract } from "@oxagen/oxagen/contracts/work.order.claim";
import { createWorkOrderClaimHandler } from "./work.order.claim";

const HOST = "tch_0123456789abcdefghjkmn";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ORDER = "wo_01k5qk7d0000000000000000";
const NOW = new Date("2026-10-02T09:00:00.000Z");
const TX = { name: "the claim's transaction" } as unknown as Tx;

const input = contract.input.parse({ host_enrollment_id: HOST, work_order_id: ORDER });
const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "host-key",
  requestId: "req",
  messageId: null,
  surface: "api",
};

/** What claimWorkOrder answers for the order, with the fields the handler reads. */
const ANSWER = {
  repeat: false,
  order: { key: "wi_7f3k:r1:s1", send: 1, briefRevision: 1 },
  orderPublicId: ORDER,
  itemPublicId: "wi_7f3k",
  itemNumber: "aintel/platform#612",
  repository: "aintel/platform",
  agentPublicId: "agt_9q2m",
  harness: "claude-code",
  prompt: "Work order wo_01k5qk7d0000000000000000 for aintel/platform#612, brief revision 1.",
};

const denied = () => new CapabilityError("claim_work_order", "authz_denied", "Forbidden: host enrollment mismatch");

const handler = createWorkOrderClaimHandler({ db: (fn) => fn(TX), now: () => NOW });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ id: HOST_ID, publicId: HOST, runtimeId: RUNTIME_ID, agentId: AGENT_ID });
  mocks.role.mockResolvedValue("Owner");
  mocks.claim.mockResolvedValue(ANSWER);
});

describe("claim_work_order", () => {
  it("refuses a key that is not the named enrollment's before it reads the order", async () => {
    mocks.resolve.mockRejectedValueOnce(denied());
    await expect(handler(input, ctx)).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.resolve).toHaveBeenCalledWith("claim_work_order", ctx, TX, HOST);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("checks the contract role after the host resolves, and claims nothing when it refuses", async () => {
    mocks.role.mockRejectedValueOnce(new HandlerError({ code: "forbidden", reason: "forbidden", message: "Forbidden" }));
    await expect(handler(input, ctx)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.role).toHaveBeenCalledWith(contract, ctx);
    expect(mocks.resolve.mock.invocationCallOrder[0]).toBeLessThan(mocks.role.mock.invocationCallOrder[0] as number);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("claims for the resolved host's id, runtime, and agent, and answers the order and its prompt", async () => {
    await expect(handler(input, ctx)).resolves.toEqual({
      repeat: false,
      work_order: {
        id: ORDER,
        key: "wi_7f3k:r1:s1",
        send: 1,
        item_id: "wi_7f3k",
        item_number: "aintel/platform#612",
        brief_revision: 1,
        repository: "aintel/platform",
        agent_id: "agt_9q2m",
        harness: "claude-code",
      },
      prompt: ANSWER.prompt,
    });
    expect(mocks.claim).toHaveBeenCalledWith(
      TX,
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      { id: HOST_ID, publicId: HOST, runtimeId: RUNTIME_ID, agentId: AGENT_ID },
      ORDER,
      NOW,
    );
  });

  it("passes a host enrolled for no agent as one with no agent", async () => {
    mocks.resolve.mockResolvedValueOnce({ id: HOST_ID, publicId: HOST, runtimeId: RUNTIME_ID, agentId: null });
    await handler(input, ctx);
    expect(mocks.claim.mock.calls[0]?.[2]).toEqual({ id: HOST_ID, publicId: HOST, runtimeId: RUNTIME_ID, agentId: null });
  });

  it("answers a work record refusal as the refusal the API maps, not a 500", async () => {
    const cases: Array<[WorkRecordError, { code: string; reason: string }]> = [
      [new WorkRecordError("forbidden", "This work order was sent to another machine."), { code: "forbidden", reason: "forbidden" }],
      [new WorkRecordError("not_found", "This workspace has no such work order."), { code: "not_found", reason: "not_found" }],
      [new WorkRecordError("conflict", "Another runtime already claimed this work order."), { code: "conflict", reason: "conflict" }],
      [new WorkRecordError("not_allowed", "Send 1 has ended (withdrawn)."), { code: "conflict", reason: "not_allowed" }],
    ];
    for (const [refusal, shape] of cases) {
      mocks.claim.mockRejectedValueOnce(refusal);
      const error = await handler(input, ctx).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(HandlerError);
      expect(error).toMatchObject({ ...shape, message: refusal.message });
    }
  });
});
