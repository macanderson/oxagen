/**
 * cancel_assistant_turn (#4164): a stop reaches only the caller's own turn,
 * in the workspace they asked in, and answers without error however often it
 * is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiKeyCreator: vi.fn((): string | null => null),
}));

// The acting user, as org-role.ts resolves it: the session user, else the
// creator of the API key.
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: {
    userId: string | null;
    apiKeyId: string | null;
  }) => ctx.userId ?? (ctx.apiKeyId ? mocks.apiKeyCreator() : null),
}));

import { isHandlerError } from "@oxagen/oxagen";
import {
  ASSISTANT_TURN_STOP_REASON,
  clearAssistantTurnsForTests,
  registerAssistantTurn,
} from "../runtime/assistant-turn-registry";
import { assistantTurnCancelHandler } from "./assistant.turn.cancel";

const TURN_ID = "0192d4a8-7c1e-7a00-8000-0000000000f1";
const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app" as const,
  messageId: null,
};

function runningTurn(over: { userId?: string; workspaceId?: string } = {}) {
  return registerAssistantTurn({
    orgId: CTX.orgId,
    workspaceId: over.workspaceId ?? CTX.workspaceId,
    userId: over.userId ?? CTX.userId,
    turnId: TURN_ID,
  });
}

beforeEach(() => {
  clearAssistantTurnsForTests();
  mocks.apiKeyCreator.mockReset().mockReturnValue(null);
});

describe("cancel_assistant_turn", () => {
  it("stops the caller's running turn and says it was found", async () => {
    const turn = runningTurn();
    await expect(
      assistantTurnCancelHandler({ turnId: TURN_ID }, CTX),
    ).resolves.toEqual({ turnId: TURN_ID, found: true });
    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe(ASSISTANT_TURN_STOP_REASON);
  });

  it("answers a second stop and a stop for an ended turn without error", async () => {
    runningTurn();
    await assistantTurnCancelHandler({ turnId: TURN_ID }, CTX);
    await expect(
      assistantTurnCancelHandler({ turnId: TURN_ID }, CTX),
    ).resolves.toEqual({ turnId: TURN_ID, found: false });

    const ended = runningTurn();
    ended.release();
    await expect(
      assistantTurnCancelHandler({ turnId: TURN_ID }, CTX),
    ).resolves.toEqual({ turnId: TURN_ID, found: false });
  });

  it("never stops another person's turn under the same id (negative)", async () => {
    const theirs = runningTurn({ userId: "user-2" });
    await expect(
      assistantTurnCancelHandler({ turnId: TURN_ID }, CTX),
    ).resolves.toEqual({ turnId: TURN_ID, found: false });
    expect(theirs.signal.aborted).toBe(false);
  });

  it("never stops the caller's turn in another workspace (negative)", async () => {
    const elsewhere = runningTurn({ workspaceId: "ws-2" });
    await expect(
      assistantTurnCancelHandler({ turnId: TURN_ID }, CTX),
    ).resolves.toEqual({ turnId: TURN_ID, found: false });
    expect(elsewhere.signal.aborted).toBe(false);
  });

  it("lets an API key stop the turn its creator asked", async () => {
    mocks.apiKeyCreator.mockReturnValue("user-1");
    const turn = runningTurn();
    await expect(
      assistantTurnCancelHandler(
        { turnId: TURN_ID },
        { ...CTX, userId: null, apiKeyId: "key-1", surface: "api" as const },
      ),
    ).resolves.toEqual({ turnId: TURN_ID, found: true });
    expect(turn.signal.aborted).toBe(true);
  });

  it("refuses a caller with no person behind it (negative)", async () => {
    const turn = runningTurn();
    const err = await assistantTurnCancelHandler(
      { turnId: TURN_ID },
      { ...CTX, userId: null, apiKeyId: null },
    ).catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(turn.signal.aborted).toBe(false);
  });
});
