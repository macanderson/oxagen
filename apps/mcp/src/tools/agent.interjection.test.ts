// agent.interjection.test.ts: the list_interjections and answer_interjection
// tools (#3839, #3941). The kernel's `invoke` and the context seam are mocked, as in
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
        kind: "question",
        raisedSeq: null,
        body: null,
        repository: null,
        path: null,
        receiptId: null,
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
    receiptId: "rcp_0123456789abcdefghjkmn",
    path: null,
    repository: null,
    workspace: null,
  };

  it("exports the contract's fields and write metadata", () => {
    expect(Object.keys(answerSchema).sort()).toEqual([
      "answer",
      "create",
      "interjectionId",
      "path",
    ]);
    expect(answerMetadata.name).toBe("answer_interjection");
    expect(answerMetadata.annotations?.readOnlyHint).toBe(false);
    expect(answerMetadata.annotations?.idempotentHint).toBe(false);
  });

  it("invokes answer_interjection on the mcp surface and returns the receipt", async () => {
    mocks.invoke.mockResolvedValue(output);
    // InferSchema makes every key required, so the optional ones are passed as undefined.
    const args = {
      interjectionId: "inj_0123456789abcdefghjkmn",
      answer: "Cut it from main.",
      path: undefined,
      create: undefined,
    };
    await expect(answerTool(args)).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "answer_interjection",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("passes a create answer through and returns the workspace it made", async () => {
    const created = {
      ...output,
      path: "create",
      repository: {
        bindingId: "rpb_0123456789abcdef012345",
        fullName: "acme/api",
      },
      workspace: { publicId: "ws_0123456789abcdefghjkmn", slug: "api" },
    };
    mocks.invoke.mockResolvedValue(created);
    const args = {
      interjectionId: "inj_0123456789abcdefghjkmn",
      answer: undefined,
      path: "create" as const,
      create: { name: "API", slug: "api" },
    };
    await expect(answerTool(args)).resolves.toEqual(created);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "answer_interjection",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("refuses an output with no receipt (negative)", async () => {
    const { receiptId: _receiptId, ...noReceipt } = output;
    mocks.invoke.mockResolvedValue(noReceipt);
    await expect(
      answerTool({
        interjectionId: "inj_0123456789abcdefghjkmn",
        answer: "Cut it from main.",
        path: undefined,
        create: undefined,
      }),
    ).rejects.toThrow();
  });
});
