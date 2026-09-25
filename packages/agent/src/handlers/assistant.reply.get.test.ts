// get_assistant_reply over fake seams: which run it answers for, what it says
// while no reply is recorded, whose conversations it reads, and that the role
// gate runs before anything is read.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import type { AssistantReplyRun } from "./assistant.reply.get";

const mocks = vi.hoisted(() => ({
  resolveActingUserId: vi.fn(),
  assertOrgRole: vi.fn(),
  getRunByPublicId: vi.fn(),
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: mocks.resolveActingUserId,
  assertOrgRole: mocks.assertOrgRole,
}));
vi.mock("../runtime/assistant-run", () => ({
  assistantRunStore: () => ({ getRunByPublicId: mocks.getRunByPublicId }),
}));

const { assistantReplyGetHandler, createAssistantReplyRead } = await import(
  "./assistant.reply.get"
);

const RUN = "arun_0123456789abcdef012345";
const OPENED = new Date("2026-09-25T10:00:00.000Z");
const PERSON = "33333333-3333-4333-8333-333333333333";
const CTX = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: PERSON,
  apiKeyId: null,
  requestId: "44444444-4444-4444-8444-444444444444",
  surface: "app",
  messageId: null,
} as const;
const REPLY = {
  conversationId: "55555555-5555-4555-8555-555555555555",
  text: "Three runs are live.",
};

function read(over: {
  run?: AssistantReplyRun | null;
  reply?: typeof REPLY | null;
  actingUser?: () => Promise<string>;
}) {
  const readRun = vi.fn(
    async (_runId: string): Promise<AssistantReplyRun | null> =>
      over.run === undefined
        ? { surface: "chat", status: "running", createdAt: OPENED }
        : over.run,
  );
  const readReply = vi.fn(async () =>
    over.reply === undefined ? null : over.reply,
  );
  const handler = createAssistantReplyRead({
    actingUser: over.actingUser ?? (async () => PERSON),
    readRun,
    readReply,
  });
  return { handler, readRun, readReply };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get_assistant_reply", () => {
  it("answers the reply the turn persisted, with its conversation, once the turn has one", async () => {
    const { handler } = read({
      run: { surface: "chat", status: "completed", createdAt: OPENED },
      reply: REPLY,
    });
    await expect(handler({ runId: RUN }, CTX)).resolves.toEqual({
      runId: RUN,
      runStatus: "completed",
      reply: REPLY,
    });
  });

  it("says the run is still going while no reply is recorded", async () => {
    const { handler } = read({ reply: null });
    await expect(handler({ runId: RUN }, CTX)).resolves.toEqual({
      runId: RUN,
      runStatus: "running",
      reply: null,
    });
  });

  it("names a run that ended without a reply by the status the ledger holds (negative)", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const { handler } = read({
        run: { surface: "chat", status, createdAt: OPENED },
        reply: null,
      });
      await expect(handler({ runId: RUN }, CTX)).resolves.toMatchObject({
        runStatus: status,
        reply: null,
      });
    }
  });

  it("reads the reply in the asking person's conversations, among messages written since the run opened", async () => {
    const { handler, readRun, readReply } = read({ reply: REPLY });
    await handler({ runId: RUN }, CTX);
    expect(readRun).toHaveBeenCalledWith(RUN);
    expect(readReply).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      userId: PERSON,
      runId: RUN,
      since: OPENED,
    });
  });

  it.each([
    ["a run this tenant has no record of", null],
    [
      "a wrapped session's run, which has no reply",
      { surface: "tacho", status: "completed", createdAt: OPENED },
    ],
  ])("reads %s as not_found and reads no reply (negative)", async (_why, run) => {
    const { handler, readReply } = read({ run });
    const err = await handler({ runId: RUN }, CTX).catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({ code: "not_found", reason: "run_not_found" });
    expect(readReply).not.toHaveBeenCalled();
  });

  it("reads nothing for a person the role gate refuses (negative)", async () => {
    const refused = new HandlerError({
      code: "forbidden",
      reason: "org_role_required",
    });
    const { handler, readRun, readReply } = read({
      actingUser: async () => {
        throw refused;
      },
    });
    await expect(handler({ runId: RUN }, CTX)).rejects.toBe(refused);
    expect(readRun).not.toHaveBeenCalled();
    expect(readReply).not.toHaveBeenCalled();
  });
});

describe("get_assistant_reply as registered", () => {
  it("checks the contract's roles for the acting person before it reads the ledger", async () => {
    mocks.resolveActingUserId.mockResolvedValue(PERSON);
    mocks.assertOrgRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    await expect(
      assistantReplyGetHandler({ runId: RUN }, CTX),
    ).rejects.toMatchObject({ reason: "org_role_required" });
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId, userId: PERSON }),
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
    expect(mocks.getRunByPublicId).not.toHaveBeenCalled();
  });

  it("answers not_found for a run id the ledger does not hold in this tenant (negative)", async () => {
    mocks.resolveActingUserId.mockResolvedValue(PERSON);
    mocks.assertOrgRole.mockResolvedValue("Owner");
    mocks.getRunByPublicId.mockResolvedValue(null);
    await expect(
      assistantReplyGetHandler({ runId: RUN }, CTX),
    ).rejects.toMatchObject({ code: "not_found", reason: "run_not_found" });
    expect(mocks.getRunByPublicId).toHaveBeenCalledWith(RUN);
  });
});
