import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  prepareAssistantTurn: vi.fn(),
  run: vi.fn(),
  withTenantDb: vi.fn(),
  log: [] as string[],
}));

vi.mock("../runtime/assistant-turn", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../runtime/assistant-turn")>();
  return { ...real, prepareAssistantTurn: mocks.prepareAssistantTurn };
});
vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...real,
    runOutsideGovernedAction: <T>(fn: () => T): T => {
      mocks.log.push("outside-frame:enter");
      const out = real.runOutsideGovernedAction(fn);
      mocks.log.push("outside-frame:exit");
      return out;
    },
  };
});
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  AssistantStoppedError,
  ConversationNotFoundError,
  AssistantTurnRefusedError,
} from "../runtime/assistant-turn";
import {
  streamAssistantTurn,
  takeAssistantStream,
} from "../runtime/assistant-stream";
import { assistantAskHandler } from "./assistant.ask";

const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "r-1",
  surface: "api" as const,
  messageId: null,
};

const RESULT = {
  conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  conversationPublicId: "cnv_01k9x2tq",
  userMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
  assistantMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
  runId: "arun_0123456789abcdef012345",
  reply: "three runs are live",
  parkedCards: [],
  // Not empty, so the pass-through below is proven rather than assumed.
  toolCalls: [
    {
      toolCallId: "tc-1",
      toolName: "list_runs",
      outcome: "completed",
      durationMs: 41,
      approvalId: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: { name?: string }) => ({
            where: () => ({
              limit: () =>
                Promise.resolve([{ slug: table === undefined ? "" : "acme" }]),
            }),
          }),
        }),
      }),
    ),
  );
  mocks.log.length = 0;
  mocks.run.mockImplementation(async () => {
    mocks.log.push("run");
    return RESULT;
  });
  mocks.prepareAssistantTurn.mockImplementation(async () => {
    mocks.log.push("prepare");
    return { run: mocks.run };
  });
});

const INPUT = {
  conversationId: null,
  content: "what is live?",
  pageContext: null,
};

describe("ask_assistant", () => {
  it("runs an unstreamed turn (the API route, the MCP tool) on the api-chat surface, outside the invoke's governed-action frame, and returns the contract's output", async () => {
    const out = await assistantAskHandler(INPUT, CTX);
    expect(mocks.prepareAssistantTurn).toHaveBeenCalledWith({
      ctx: CTX,
      surface: "api-chat",
      orgSlug: "acme",
      workspaceSlug: "acme",
      content: "what is live?",
      conversationId: null,
      pageContext: null,
    });
    expect(mocks.run).toHaveBeenCalledWith(undefined);
    // The turn's tool calls are top-level governed actions (ADR-053 §1).
    expect(mocks.log).toEqual([
      "prepare",
      "outside-frame:enter",
      "run",
      "outside-frame:exit",
    ]);
    expect(out).toEqual(RESULT);
  });

  // The flyout in apps/app invokes through kernelWrite, which carries no
  // stream and sets surface "app". Reading only the stream recorded every
  // in-app turn as api-chat — and `assistant-turn.ts` then wrote its AI
  // telemetry on the `api` surface — so the ledger said API about a question
  // a person asked in the product.
  it("records a turn the app asked from a Server Action on the chat surface, though it carries no stream", async () => {
    const out = await assistantAskHandler(INPUT, { ...CTX, surface: "app" });
    expect(mocks.prepareAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "chat" }),
    );
    expect(out).toEqual(RESULT);
  });

  it.each(["api", "mcp", "runner"] as const)(
    "keeps a %s caller on api-chat, which is what excludes it from the customer's own runs (negative)",
    async (surface) => {
      await assistantAskHandler(INPUT, { ...CTX, surface });
      expect(mocks.prepareAssistantTurn).toHaveBeenCalledWith(
        expect.objectContaining({ surface: "api-chat" }),
      );
    },
  );

  it("takes the stream the SSE route carries beside the invoke: its overrides, its prepared signal, its hooks", async () => {
    const hooks = { onPart: () => undefined };
    const onPrepared = vi.fn(() => mocks.log.push("prepared"));
    let nested: unknown = "unset";
    mocks.run.mockImplementationOnce(async () => {
      mocks.log.push("run");
      nested = takeAssistantStream();
      return RESULT;
    });
    await streamAssistantTurn(
      {
        overrides: { tier: "fast", activeServerIds: ["srv"] },
        hooks,
        onPrepared,
      },
      () => assistantAskHandler(INPUT, CTX),
    );
    // The SSE route is the app's transport: its turn is admitted on `chat`.
    expect(mocks.prepareAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat",
        tier: "fast",
        activeServerIds: ["srv"],
      }),
    );
    expect(mocks.run).toHaveBeenCalledWith(hooks);
    expect(mocks.log.filter((l) => !l.startsWith("outside"))).toEqual([
      "prepare",
      "prepared",
      "run",
    ]);
    // The handler took it once; an invoke nested in the turn sees none.
    expect(nested).toBeNull();
  });

  it("maps an unknown conversation to not_found (negative)", async () => {
    mocks.run.mockRejectedValueOnce(
      new ConversationNotFoundError("0192d4a8-7c1e-7a00-8000-0000000000c9"),
    );
    await expect(assistantAskHandler(INPUT, CTX)).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.code === "not_found",
    );
  });

  it("answers a switched-off assistant as forbidden with reason kill_switch, before the stream is told the turn is prepared", async () => {
    mocks.prepareAssistantTurn.mockRejectedValueOnce(
      new AssistantStoppedError("edn_stop", "incident 42"),
    );
    const onPrepared = vi.fn();
    await expect(
      streamAssistantTurn({ overrides: {}, hooks: {}, onPrepared }, () =>
        assistantAskHandler(INPUT, CTX),
      ),
    ).rejects.toSatisfy(
      (e) =>
        isHandlerError(e) &&
        e.code === "forbidden" &&
        e.reason === "kill_switch" &&
        e.message.includes("edn_stop"),
    );
    expect(onPrepared).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("lets a credit-gate refusal through with its own code, before the stream is told the turn is prepared", async () => {
    mocks.prepareAssistantTurn.mockRejectedValueOnce(
      new AssistantTurnRefusedError("billing_suspended", "suspended"),
    );
    const onPrepared = vi.fn();
    await expect(
      streamAssistantTurn({ overrides: {}, hooks: {}, onPrepared }, () =>
        assistantAskHandler(INPUT, CTX),
      ),
    ).rejects.toMatchObject({ code: "billing_suspended" });
    expect(onPrepared).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
