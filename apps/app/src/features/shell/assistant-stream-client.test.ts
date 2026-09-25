// The flyout's stream client over a fake `fetch`: what it posts and where,
// how it reads the chat stream's wire as the engine writes it, and how every
// way a turn ends reaches the flyout in the shape the Server Action gave it,
// classified by the codes the kernel seam classifies.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askAssistantStream,
  refusalOfCode,
  refusalOfResponse,
} from "./assistant-stream-client";

const TURN = {
  conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
  userMessageId: "6f1f5a8e-0000-4000-8000-00000000a111",
  assistantMessageId: "6f1f5a8e-0000-4000-8000-00000000a222",
  runId: "arun_01k9",
  reply: "Three runs are live.",
  parkedCards: [],
};

const QUESTION = {
  conversationId: null,
  content: "what is live?",
  route: "fleet",
  entityId: null,
};

const data = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const done = (output: unknown) =>
  `event: done\ndata: ${typeof output === "string" ? output : JSON.stringify(output)}\n\n`;

/**
 * A response whose body arrives in the chunks given, then either ends or
 * breaks the way a dropped connection does.
 */
function sse(chunks: readonly string[], end: "close" | "break" = "close") {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) {
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      if (end === "break") controller.error(new TypeError("network error"));
      else controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function respond(response: Response) {
  const fetch = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The body the client posted, read back as JSON. */
function posted(fetch: ReturnType<typeof respond>): unknown {
  const init = fetch.mock.calls[0]?.[1];
  return JSON.parse(typeof init?.body === "string" ? init.body : "null");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("askAssistantStream", () => {
  it("posts the question and the page it was asked from to the workspace's chat stream, same-origin", async () => {
    const fetch = respond(sse([done(TURN)]));
    await askAssistantStream("acme", "core-platform", {
      ...QUESTION,
      route: "runs",
      entityId: "arun_01k8",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/v1/acme/core-platform/chat/stream",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
    });
    expect(posted(fetch)).toEqual({
      conversationId: null,
      content: "what is live?",
      pageContext: {
        route: "runs",
        orgSlug: "acme",
        workspaceSlug: "core-platform",
        entityId: "arun_01k8",
        entityLabel: null,
      },
    });
  });

  // The Run page names its run, so a question asked there reaches the turn
  // with the title the person sees beside the id the agent can look up.
  it("sends the label the page gave its record, beside the record's id", async () => {
    const fetch = respond(sse([done(TURN)]));
    await askAssistantStream("acme", "core-platform", {
      ...QUESTION,
      route: "runs",
      entityId: "arun_01k9",
      entityLabel: "Fix the flaky checkout test",
    });
    expect(posted(fetch)).toEqual({
      conversationId: null,
      content: "what is live?",
      pageContext: {
        route: "runs",
        orgSlug: "acme",
        workspaceSlug: "core-platform",
        entityId: "arun_01k9",
        entityLabel: "Fix the flaky checkout test",
      },
    });
  });

  it("sends a null page context when the caller has no page", async () => {
    const fetch = respond(sse([done(TURN)]));
    await askAssistantStream("acme", "core-platform", {
      ...QUESTION,
      route: null,
    });
    expect(posted(fetch)).toMatchObject({ pageContext: null });
  });

  it("hands over the run, each fragment and each tool call as it arrives, then answers the turn", async () => {
    const toolEnded = data({
      type: "tool-call-end",
      toolCallId: "c1",
      status: "completed",
      durationMs: 40,
    });
    respond(
      sse([
        data({ type: "run", runId: "arun_01k9" }),
        data({ type: "step-start", stepIndex: 0 }),
        data({
          type: "tool-call-start",
          toolCallId: "c1",
          capability: "list_runs",
          inputPreview: {},
          riskLevel: "low",
        }),
        // A keep-alive while the tool runs, and a message split across two
        // network chunks.
        ": keep-alive\n\n",
        toolEnded.slice(0, 20),
        toolEnded.slice(20),
        data({ type: "text", text: "Three runs " }),
        data({ type: "text", text: "are live." }),
        data({
          type: "usage",
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        }),
        done(TURN),
      ]),
    );
    const heard: unknown[] = [];
    const result = await askAssistantStream(
      "acme",
      "core-platform",
      QUESTION,
      {
        onRun: (runId) => heard.push(["run", runId]),
        onText: (delta) => heard.push(["text", delta]),
        onToolStart: (call) => heard.push(["start", call]),
        onToolEnd: (call) => heard.push(["end", call]),
      },
    );
    expect(heard).toEqual([
      ["run", "arun_01k9"],
      ["start", { id: "c1", capability: "list_runs" }],
      ["end", { id: "c1", status: "completed" }],
      ["text", "Three runs "],
      ["text", "are live."],
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        conversationId: TURN.conversationId,
        runId: TURN.runId,
        reply: TURN.reply,
        parkedCards: [],
      },
    });
  });

  it("names each parked write as it parks, and leaves a budget pause out", async () => {
    const parked = {
      approvalId: "apr_01",
      capability: "rotate_api_key",
      expiresAt: "2026-09-25T10:05:00.000Z",
    };
    respond(
      sse([
        data({ type: "approval-required", ...parked, riskLevel: "high" }),
        data({
          type: "approval-required",
          approvalId: "apr_02",
          capability: "budget.turn.continue",
          expiresAt: "2026-09-25T10:05:00.000Z",
          riskLevel: "low",
        }),
        done({ ...TURN, parkedCards: [parked] }),
      ]),
    );
    const onParked = vi.fn();
    const result = await askAssistantStream(
      "acme",
      "core-platform",
      QUESTION,
      { onParked },
    );
    expect(onParked.mock.calls).toEqual([[parked]]);
    expect(result).toMatchObject({
      ok: true,
      value: { parkedCards: [parked] },
    });
  });

  it("answers a failure after the stream opened with the kernel seam's classification (negative)", async () => {
    respond(
      sse([
        data({ type: "run", runId: "arun_01k9" }),
        data({ type: "text", text: "Three" }),
        data({
          type: "error",
          message: "the assistant engine is unavailable",
          code: "engine_unavailable",
        }),
        done("[DONE]"),
      ]),
    );
    await expect(
      askAssistantStream("acme", "core-platform", QUESTION),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      code: "engine_unavailable",
    });
  });

  it("answers dropped with the run it named when the stream ends before its terminal (negative)", async () => {
    respond(
      sse([
        data({ type: "run", runId: "arun_01k9" }),
        data({ type: "text", text: "Three runs" }),
      ]),
    );
    const onText = vi.fn();
    const result = await askAssistantStream(
      "acme",
      "core-platform",
      QUESTION,
      { onText },
    );
    expect(onText).toHaveBeenCalledWith("Three runs");
    expect(result).toEqual({
      ok: false,
      reason: "dropped",
      runId: "arun_01k9",
    });
  });

  it("answers dropped when the connection breaks mid-stream, and never rejects (negative)", async () => {
    respond(sse([data({ type: "run", runId: "arun_01k9" })], "break"));
    await expect(
      askAssistantStream("acme", "core-platform", QUESTION),
    ).resolves.toEqual({ ok: false, reason: "dropped", runId: "arun_01k9" });
  });

  it("answers dropped with no run when the stream breaks before it named one (negative)", async () => {
    respond(sse([], "break"));
    await expect(
      askAssistantStream("acme", "core-platform", QUESTION),
    ).resolves.toEqual({ ok: false, reason: "dropped", runId: null });
  });

  it("answers unavailable when the request never reached the route (negative)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(
      askAssistantStream("acme", "core-platform", QUESTION),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      code: "network_error",
    });
  });

  it("answers a refusal the route gave before the stream opened, from its status and envelope (negative)", async () => {
    respond(
      Response.json(
        {
          error: {
            code: "insufficient_credits",
            message: "The balance is empty",
          },
          requestId: "r1",
        },
        { status: 402 },
      ),
    );
    await expect(
      askAssistantStream("acme", "core-platform", QUESTION),
    ).resolves.toEqual({
      ok: false,
      reason: "exhausted",
      code: "insufficient_credits",
    });
  });

  // An operator's `agent` kill switch on the assistant refuses the turn
  // before it is prepared, so the route answers 403 before the stream opens.
  it("answers a kill switch on the assistant as denied, named by the switch (negative)", async () => {
    respond(
      Response.json(
        {
          error: {
            code: "forbidden",
            reason: "kill_switch",
            message: "An agent kill switch is on: incident 42",
          },
          requestId: "r1",
        },
        { status: 403 },
      ),
    );
    await expect(
      askAssistantStream("acme", "core-platform", QUESTION),
    ).resolves.toEqual({ ok: false, reason: "denied", code: "kill_switch" });
  });

  it("refuses a terminal that is not a turn rather than inventing a reply (negative)", async () => {
    respond(sse([done({ reply: 7 })]));
    await expect(
      askAssistantStream("acme", "core-platform", QUESTION),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      code: "contract_output_mismatch",
    });
  });
});

describe("the refusal codes, as the kernel seam classifies them", () => {
  it.each([
    ["insufficient_credits", "exhausted"],
    ["assistant_spend_cap", "exhausted"],
    ["assistant_model_key_limit", "exhausted"],
    ["engine_aborted", "conflict"],
    ["conversation_not_found", "not_found"],
    ["no_principal", "denied"],
    ["kill_switch", "denied"],
    ["engine_unavailable", "unavailable"],
    ["assistant_run_not_recorded", "unavailable"],
    ["model_call_failed", "unavailable"],
  ])("reads a stream error named %s as %s", (code, reason) => {
    expect(refusalOfCode(code)).toEqual({ ok: false, reason, code });
  });

  it("reads a stream error with no code as the seam's unclassified failure", () => {
    expect(refusalOfCode(undefined)).toEqual({
      ok: false,
      reason: "unavailable",
      code: "kernel_failure",
    });
  });

  it.each([
    [
      400,
      { error: "Invalid body" },
      { reason: "invalid", code: "invalid_input" },
    ],
    [
      401,
      { error: { code: "unauthorized" } },
      { reason: "denied", code: "unauthorized" },
    ],
    [
      403,
      { error: { code: "forbidden", reason: "org_role_required" } },
      { reason: "denied", code: "org_role_required" },
    ],
    [
      403,
      { error: { code: "pending_approval", accessRequestId: "ar_1" } },
      { reason: "pending_approval", accessRequestId: "ar_1" },
    ],
    [
      404,
      { error: { code: "not_found", reason: "conversation_not_found" } },
      { reason: "not_found", code: "conversation_not_found" },
    ],
    [
      409,
      { error: { code: "engine_aborted" } },
      { reason: "conflict", code: "engine_aborted" },
    ],
    [
      429,
      { error: "rate_limited" },
      { reason: "unavailable", code: "rate_limited" },
    ],
    [
      503,
      { error: { code: "engine_unavailable" } },
      { reason: "unavailable", code: "engine_unavailable" },
    ],
    [500, null, { reason: "unavailable", code: "kernel_failure" }],
  ])("reads a %i before the stream opened", (status, body, refusal) => {
    expect(refusalOfResponse(status, body)).toEqual({ ok: false, ...refusal });
  });
});
