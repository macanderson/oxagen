/**
 * ask_assistant with a `turnId` (#4164): the turn registers under the person
 * who asked, `cancel_assistant_turn`'s stop reaches it as both the abort and
 * the stop signal, and the turn drops out when it ends, however it ends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareAssistantTurn: vi.fn(),
  run: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("../runtime/assistant-turn", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../runtime/assistant-turn")>();
  return { ...real, prepareAssistantTurn: mocks.prepareAssistantTurn };
});
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { streamAssistantTurn } from "../runtime/assistant-stream";
import type { AssistantTurnHooks } from "../runtime/assistant-turn";
import {
  ASSISTANT_TURN_STOP_REASON,
  clearAssistantTurnsForTests,
  stopAssistantTurn,
} from "../runtime/assistant-turn-registry";
import { assistantAskHandler } from "./assistant.ask";

const TURN_ID = "0192d4a8-7c1e-7a00-8000-0000000000f1";
const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "r-1",
  surface: "app" as const,
  messageId: null,
};
/** The key `cancel_assistant_turn` builds for the person who asked. */
const KEY = {
  orgId: CTX.orgId,
  workspaceId: CTX.workspaceId,
  userId: "u-1",
  turnId: TURN_ID,
};
const RESULT = {
  conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  conversationPublicId: "cnv_01k9x2tq",
  userMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
  assistantMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
  runId: "arun_0123456789abcdef012345",
  reply: "The run failed at",
  parkedCards: [],
  stopped: false,
};
const INPUT = {
  conversationId: null,
  content: "why did it fail?",
  pageContext: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearAssistantTurnsForTests();
  mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ slug: "acme" }]) }),
          }),
        }),
      }),
    ),
  );
  mocks.run.mockResolvedValue(RESULT);
  // `userId` is the person the gates named: the one the stop must match.
  mocks.prepareAssistantTurn.mockResolvedValue({
    userId: "u-1",
    run: mocks.run,
  });
});

describe("ask_assistant with a turn id", () => {
  it("hands the turn a stop that aborts it with the person's reason, and returns the turn's stopped flag", async () => {
    let seen: AssistantTurnHooks | undefined;
    mocks.run.mockImplementation(async (hooks?: AssistantTurnHooks) => {
      seen = hooks;
      expect(hooks?.stopSignal?.aborted).toBe(false);
      expect(hooks?.abortSignal?.aborted).toBe(false);
      // The person presses Stop while the turn runs.
      expect(stopAssistantTurn(KEY)).toEqual({ found: true });
      return { ...RESULT, stopped: hooks?.stopSignal?.aborted === true };
    });

    const out = await assistantAskHandler({ ...INPUT, turnId: TURN_ID }, CTX);

    expect(seen?.stopSignal?.reason).toBe(ASSISTANT_TURN_STOP_REASON);
    expect(seen?.abortSignal?.aborted).toBe(true);
    expect(out.stopped).toBe(true);
    expect(out.reply).toBe("The run failed at");
  });

  // POST /chat/stream hands the turn its hooks and no abort signal: a dropped
  // connection is not a stop (ADR-092, ADR-176). The stop must still reach
  // the turn there, through the registry's own controller.
  it("stops a streamed turn that carries no request signal, and keeps the stream's hooks", async () => {
    const onPart = vi.fn();
    let seen: AssistantTurnHooks | undefined;
    mocks.run.mockImplementation(async (hooks?: AssistantTurnHooks) => {
      seen = hooks;
      expect(hooks?.abortSignal?.aborted).toBe(false);
      expect(stopAssistantTurn(KEY)).toEqual({ found: true });
      return { ...RESULT, stopped: hooks?.stopSignal?.aborted === true };
    });

    const out = await streamAssistantTurn(
      { overrides: {}, hooks: { onPart }, onPrepared: () => undefined },
      () => assistantAskHandler({ ...INPUT, turnId: TURN_ID }, CTX),
    );

    expect(seen?.onPart).toBe(onPart);
    expect(seen?.abortSignal).toBe(seen?.stopSignal);
    expect(seen?.abortSignal?.reason).toBe(ASSISTANT_TURN_STOP_REASON);
    expect(out.stopped).toBe(true);
  });

  it("forgets the turn once it returns: a later stop finds nothing", async () => {
    await assistantAskHandler({ ...INPUT, turnId: TURN_ID }, CTX);
    expect(stopAssistantTurn(KEY)).toEqual({ found: false });
  });

  it("forgets the turn when it throws, too (negative)", async () => {
    const failure = Object.assign(new Error("engine down"), {
      code: "engine_unavailable",
    });
    mocks.run.mockRejectedValue(failure);
    await expect(
      assistantAskHandler({ ...INPUT, turnId: TURN_ID }, CTX),
    ).rejects.toBe(failure);
    expect(stopAssistantTurn(KEY)).toEqual({ found: false });
  });

  it("registers under the person who asked, so another person's stop never reaches it (negative)", async () => {
    mocks.run.mockImplementation(async (hooks?: AssistantTurnHooks) => {
      expect(stopAssistantTurn({ ...KEY, userId: "u-2" })).toEqual({
        found: false,
      });
      expect(hooks?.stopSignal?.aborted).toBe(false);
      return RESULT;
    });
    const out = await assistantAskHandler({ ...INPUT, turnId: TURN_ID }, CTX);
    expect(out.stopped).toBe(false);
  });

  it("registers nothing and adds no stop without a turn id (negative)", async () => {
    mocks.run.mockImplementation(async (hooks?: AssistantTurnHooks) => {
      expect(stopAssistantTurn(KEY)).toEqual({ found: false });
      expect(hooks).toBeUndefined();
      return RESULT;
    });
    await assistantAskHandler(INPUT, CTX);
    expect(mocks.run).toHaveBeenCalledWith(undefined);
  });
});
