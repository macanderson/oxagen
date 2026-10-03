// `reject_work_order` (ADR-251): the host key is checked before anything reads
// the order, the resolved host is what the rejection is checked against, and
// a work record refusal reaches the API as a refusal, never a 500. The
// rejection's own rules (target host, a linked run, another claimant) run
// against Postgres in lib/work-records/dispatch.pg.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@oxagen/database";
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { WorkRecordError } from "@oxagen/work/records";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  role: vi.fn(),
  reject: vi.fn(),
}));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolve }));
vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));
vi.mock("./lib/work-records/runtime", () => ({ rejectWorkOrder: mocks.reject }));

import { workOrderReject as contract } from "@oxagen/oxagen/contracts/work.order.reject";
import { createWorkOrderRejectHandler } from "./work.order.reject";

const HOST = "tch_0123456789abcdefghjkmn";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ORDER = "wo_01k5qk7d0000000000000000";
const REASON = "This machine has no checkout of aintel/platform.";
const NOW = new Date("2026-10-02T09:00:00.000Z");
const TX = { name: "the rejection's transaction" } as unknown as Tx;

const input = contract.input.parse({ host_enrollment_id: HOST, work_order_id: ORDER, reason: REASON });
const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "host-key",
  requestId: "req",
  messageId: null,
  surface: "api",
};

const denied = () => new CapabilityError("reject_work_order", "authz_denied", "Forbidden: host enrollment mismatch");

const handler = createWorkOrderRejectHandler({ db: (fn) => fn(TX), now: () => NOW });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ id: HOST_ID, publicId: HOST, runtimeId: RUNTIME_ID, agentId: AGENT_ID });
  mocks.role.mockResolvedValue("Owner");
  mocks.reject.mockResolvedValue({ repeat: false });
});

describe("reject_work_order", () => {
  it("refuses a key that is not the named enrollment's before it reads the order", async () => {
    mocks.resolve.mockRejectedValueOnce(denied());
    await expect(handler(input, ctx)).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.resolve).toHaveBeenCalledWith("reject_work_order", ctx, TX, HOST);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("checks the contract role after the host resolves, and rejects nothing when it refuses", async () => {
    mocks.role.mockRejectedValueOnce(new HandlerError({ code: "forbidden", reason: "forbidden", message: "Forbidden" }));
    await expect(handler(input, ctx)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.role).toHaveBeenCalledWith(contract, ctx);
    expect(mocks.resolve.mock.invocationCallOrder[0]).toBeLessThan(mocks.role.mock.invocationCallOrder[0] as number);
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("rejects for the resolved host's id, runtime, and agent, with the host's reason", async () => {
    await expect(handler(input, ctx)).resolves.toEqual({ repeat: false });
    expect(mocks.reject).toHaveBeenCalledWith(
      TX,
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      { id: HOST_ID, publicId: HOST, runtimeId: RUNTIME_ID, agentId: AGENT_ID },
      ORDER,
      REASON,
      NOW,
    );
  });

  it("answers a repeat rejection as a repeat", async () => {
    mocks.reject.mockResolvedValueOnce({ repeat: true });
    await expect(handler(input, ctx)).resolves.toEqual({ repeat: true });
  });

  it("answers a work record refusal as the refusal the API maps, not a 500", async () => {
    const cases: Array<[WorkRecordError, { code: string; reason: string }]> = [
      [new WorkRecordError("forbidden", "This work order went to another runtime."), { code: "forbidden", reason: "forbidden" }],
      [new WorkRecordError("not_found", "This workspace has no such work order."), { code: "not_found", reason: "not_found" }],
      [new WorkRecordError("conflict", "Another runtime claimed this work order."), { code: "conflict", reason: "conflict" }],
      [
        new WorkRecordError("not_allowed", "A run is linked to this work order. Its end is the record, not a rejection."),
        { code: "conflict", reason: "not_allowed" },
      ],
    ];
    for (const [refusal, shape] of cases) {
      mocks.reject.mockRejectedValueOnce(refusal);
      const error = await handler(input, ctx).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(HandlerError);
      expect(error).toMatchObject({ ...shape, message: refusal.message });
    }
  });
});
