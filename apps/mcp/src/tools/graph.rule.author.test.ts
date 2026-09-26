// graph.rule.author.test.ts: schema and invocation tests for the
// author_graph_rule MCP tool (same pattern as conversation.get.test.ts: mock
// the kernel `invoke` and the context seam `buildContext`). The handler and
// the turn it asks for are proven in packages/agent.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { obj } from "./_schema-test-helpers";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

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

import authorGraphRuleTool, { metadata, schema } from "./graph.rule.author";

const RULE = {
  relationshipType: "OWNS_ACCOUNT",
  start: { label: "Person", source: "hubspot" },
  end: { label: "Account", source: "stripe" },
};

const OUTPUT = {
  goal: {
    statement:
      "The relationship rule OWNS_ACCOUNT links Person nodes from hubspot to Account nodes from stripe.",
    maxRounds: 3,
  },
  goalMet: true,
  turn: {
    conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
    conversationPublicId: "cnv_01k9x2tq",
    userMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
    assistantMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
    runId: "arun_0123456789abcdef012345",
    reply: "OWNS_ACCOUNT links Ada Lovelace to acct_42.",
    parkedCards: [],
    toolCalls: [],
    stopped: false,
  },
};

const ARGS = {
  rule: RULE,
  note: undefined,
  conversationId: null,
  turnId: undefined,
};

describe("author_graph_rule tool", () => {
  it("is a writing, non-idempotent tool named for the capability", () => {
    expect(metadata.name).toBe("author_graph_rule");
    expect(metadata.annotations?.readOnlyHint).toBe(false);
    expect(metadata.annotations?.idempotentHint).toBe(false);
    expect(Object.keys(schema).sort()).toEqual([
      "conversationId",
      "note",
      "rule",
      "turnId",
    ]);
  });

  it("keeps the contract's refusals under the described fields (negative)", () => {
    const Schema = obj(schema);
    expect(Schema.safeParse({ rule: RULE }).success).toBe(true);
    // The two-source refinement survives `.describe()`.
    expect(
      Schema.safeParse({
        rule: { ...RULE, end: { label: "Account", source: "hubspot" } },
      }).success,
    ).toBe(false);
    expect(Schema.safeParse({ rule: RULE, note: "   " }).success).toBe(false);
    expect(schema.conversationId.parse(undefined)).toBeNull();
  });

  it("invokes author_graph_rule on the mcp surface and returns the parsed output", async () => {
    mocks.invoke.mockResolvedValue(OUTPUT);

    const out = await authorGraphRuleTool(ARGS);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "author_graph_rule",
      ARGS,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(out).toEqual(OUTPUT);
  });

  it("refuses an output that drifts from the contract (negative)", async () => {
    mocks.invoke.mockResolvedValue({ ...OUTPUT, goalMet: "yes" });

    await expect(authorGraphRuleTool(ARGS)).rejects.toThrow();
  });

  it("propagates an engine_aborted refusal (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("goal not met after 3 rounds"), {
        code: "engine_aborted",
      }),
    );

    await expect(authorGraphRuleTool(ARGS)).rejects.toMatchObject({
      code: "engine_aborted",
    });
  });
});
