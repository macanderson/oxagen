// agent.interjection.test.ts: the list_interjections and answer_interjection
// tools (#3839). The kernel's `invoke` and the context seam are mocked, as in
// agent.handlers.test.ts, so each tool runs without a live runtime and each
// fake output satisfies its contract's output schema.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import listTool, {
  metadata as listMetadata,
  schema as listSchema,
} from "./agent.interjection.list";
import answerTool, {
  metadata as answerMetadata,
  schema as answerSchema,
} from "./agent.interjection.answer";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("list_interjections tool", () => {
  const output = {
    items: [
      {
        id: "inj_0123456789abcdefghjkmn",
        runId: "tse_0123456789abcdefghjkmn",
        agentKey: "acme.core.release-bot",
        question: "Which branch should the release cut from?",
        raisedAt: "2026-09-25T09:00:00.000Z",
        expiresAt: "2026-09-25T09:30:00.000Z",
        answeredAt: null,
        answer: null,
        answeredBy: null,
      },
    ],
    nextCursor: null,
  };

  it("exports the contract's fields and read-only metadata", () => {
    expect(Object.keys(listSchema).sort()).toEqual([
      "cursor",
      "limit",
      "open",
      "runId",
    ]);
    expect(listMetadata.name).toBe("list_interjections");
    expect(listMetadata.annotations?.readOnlyHint).toBe(true);
  });

  it("invokes list_interjections on the mcp surface and returns the parsed page", async () => {
    mocks.invoke.mockResolvedValue(output);
    const args = { open: true, limit: 50, runId: undefined, cursor: undefined };
    await expect(listTool(args)).resolves.toEqual(output);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_interjections",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("refuses an output the contract does not allow (negative)", async () => {
    mocks.invoke.mockResolvedValue({
      items: [{ id: "apr_x" }],
      nextCursor: null,
    });
    await expect(
      listTool({ open: true, limit: 50, runId: undefined, cursor: undefined }),
    ).rejects.toThrow();
  });
});

describe("answer_interjection tool", () => {
  const output = {
    interjectionId: "inj_0123456789abcdefghjkmn",
    runId: "tse_0123456789abcdefghjkmn",
    answeredAt: "2026-09-25T09:10:00.000Z",
    commandIds: ["tcm_0123456789abcdefghjkmn"],
  };

  it("exports the contract's fields and write metadata", () => {
    expect(Object.keys(answerSchema).sort()).toEqual([
      "answer",
      "interjectionId",
    ]);
    expect(answerMetadata.name).toBe("answer_interjection");
    expect(answerMetadata.annotations?.readOnlyHint).toBe(false);
    expect(answerMetadata.annotations?.idempotentHint).toBe(false);
  });

  it("invokes answer_interjection on the mcp surface and returns the receipt", async () => {
    mocks.invoke.mockResolvedValue(output);
    const args = {
      interjectionId: "inj_0123456789abcdefghjkmn",
      answer: "Cut it from main.",
    };
    await expect(answerTool(args)).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "answer_interjection",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
