import { Hono } from "hono";
import { z } from "zod";
import { streamAssistantTurn } from "@oxagen/agent";
import { requestTurnBudgetSchema } from "@oxagen/billing";
import { isHandlerError } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import { CHAT_CONTENT_MAX_CHARS } from "@oxagen/oxagen/contracts/chat.message.send";
import {
  assistantAsk,
  assistantGoalSchema,
  assistantPageContextSchema,
} from "@oxagen/oxagen/contracts/assistant.ask";
import { capabilityContext } from "../../lib/context";
import { ASSISTANT_TURN_ERROR_STATUS } from "../../middleware/error";
import type { AppEnv } from "../../app";
import {
  createApiStreamTranslator,
  type ApiStreamEvent,
} from "./chat-stream-translator";

// Request shape for POST /:org_slug/:workspace_slug/chat/stream.
//
// This is the ingress contract the surface has always published; every 400 a
// caller depends on — malformed JSON, a missing/empty message, an oversized
// body, a nonsense budget override — is defined here.
const BodySchema = z.object({
  // Bound the message body — the shared per-message ingress cap (see
  // CHAT_CONTENT_MAX_CHARS in the chat.message.send contract) so every chat
  // surface rejects oversized prompts identically.
  content: z.string().min(1).max(CHAT_CONTENT_MAX_CHARS),
  // The contract's own field: an internal id or a `cnv_` public id. The
  // flyout continues a thread it read back on reload by the public id
  // `get_conversation` returns, so a UUID-only rule here would refuse the
  // first question after every reload.
  conversationId: assistantAsk.input.shape.conversationId,
  // Where the person is (the app's flyout); null for a caller with no page.
  pageContext: assistantPageContextSchema.nullable().default(null),
  // A goal-shaped turn: the engine's verifier judges each round against it
  // (ADR-177). Omitted for an ordinary turn, as in ask_assistant's input.
  goal: assistantGoalSchema.optional(),
  // Per-turn MCP server allowlist. When non-empty, only those servers' tools
  // are loaded for this turn. Omit or pass [] to load all workspace MCPs.
  activeServerIds: z.array(z.string()).optional().default([]),
  // Optional model overrides — omit to use workspace/user defaults.
  tier: z.enum(["fast", "balanced", "precise"]).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  effort: z.enum(["low", "medium", "high"]).nullable().default(null),
  // Per-turn dollar-budget override. `null`/omitted means "no override for
  // this turn" — the saved default applies (@oxagen/billing).
  budget: requestTurnBudgetSchema.nullable().default(null),
});

export const chatStreamRoute = new Hono<AppEnv>();

/**
 * How often an open stream writes an SSE comment while the turn is quiet. A
 * turn can go a minute without a part: a slow tool call, a long model call.
 * The app reaches this route through its `/api/v1/*` rewrite, and Next.js
 * closes a proxied socket that is idle for 30 seconds; a load balancer's idle
 * timeout does the same. A comment every 15 seconds keeps the connection
 * open, and every SSE reader skips it.
 */
export const CHAT_STREAM_HEARTBEAT_MS = 15_000;

// POST /:org_slug/:workspace_slug/chat/stream
//
// The one SSE transport of the in-app agent (apps/app/ARCHITECTURE.md §3.5,
// ADR-176): the streaming adapter of `ask_assistant`, and the transport the
// app's assistant flyout reads, same-origin through the app's `/api/v1/*`
// rewrite. Body: this route's BodySchema, the contract's input plus the
// surface's model and budget overrides. Each SSE line: `data: <JSON
// ApiStreamEvent>\n\n`, with a `: keep-alive` comment while the turn is quiet.
// Terminal: `event: done\ndata: <JSON ask_assistant output>\n\n`.
//
// The turn is `invoke("ask_assistant")`, exactly as on POST /assistant/ask, so
// the contract's IAM, audit, rules and billing gates and its handler's role
// gate run here too. The hooks and overrides ride beside the invoke
// (`streamAssistantTurn`). A refusal before the turn is prepared leaves
// through the error middleware as the response, with the status
// /assistant/ask answers; after that the stream is open and a failure is a
// typed `error` event.
//
// A dropped connection does not stop the turn (ADR-092, ADR-176). The turn
// runs to completion and persists its reply, so a client that lost the
// stream can read the finished reply with `get_assistant_reply`. Stopping a
// turn on purpose belongs to run controls (#2953), not to a socket closing:
// cancelling mid-turn can leave a governed write half done, and a network
// blip is not a decision to stop.
chatStreamRoute.post("/", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      400,
    );
  }
  const body = parsed.data;
  const ctx = capabilityContext(c);

  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const responseStream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let closed = false;
  function write(chunk: string): void {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // Client disconnected — the controller is closed. Latch it so the
      // translator's synchronous emits become no-ops.
      closed = true;
    }
  }
  const emit = (event: ApiStreamEvent): void =>
    write(`data: ${JSON.stringify(event)}\n\n`);

  // The translator names tool calls by capability; the turn hands the alias
  // map over before the first part.
  let translator = createApiStreamTranslator({ toolNameMap: {}, emit });
  let prepared!: () => void;
  const preparedSignal = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const turn = streamAssistantTurn(
    {
      overrides: {
        activeServerIds: body.activeServerIds,
        tier: body.tier,
        model: body.model,
        effort: body.effort,
        budget: body.budget,
      },
      hooks: {
        onTools: (toolNameMap) => {
          translator = createApiStreamTranslator({ toolNameMap, emit });
        },
        onRun: ({ runId }) => emit({ type: "run", runId }),
        onApprovalRequired: (approval) =>
          emit({
            type: "approval-required",
            approvalId: approval.approvalId,
            capability: approval.capability,
            inputPreview: approval.inputPreview,
            riskLevel: approval.riskLevel,
            expiresAt: approval.expiresAt,
          }),
        onBudgetNotice: (notice) => emit({ type: "budget-notice", ...notice }),
        onPart: (part) => translator.onPart(part),
        // ONE aggregated usage event for the turn, last before the terminal.
        onUsage: (usage) =>
          emit({
            type: "usage",
            usage: {
              promptTokens: usage.inputTokens,
              completionTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            },
          }),
        // No `abortSignal`: the request's signal fires when the client goes
        // away, and a turn the person walked away from is owned to
        // completion (ADR-092). Only the writes above stop.
      },
      onPrepared: prepared,
    },
    () =>
      invoke(
        assistantAsk.name,
        {
          conversationId: body.conversationId,
          content: body.content,
          pageContext: body.pageContext,
          ...(body.goal ? { goal: body.goal } : {}),
        },
        ctx,
        { surface: "api" },
      ),
  );

  // A refusal before the turn is prepared rejects here and becomes the
  // response through the error middleware.
  await Promise.race([preparedSignal, turn]);

  const heartbeat = setInterval(() => {
    if (closed) {
      clearInterval(heartbeat);
      return;
    }
    write(": keep-alive\n\n");
  }, CHAT_STREAM_HEARTBEAT_MS);

  void turn
    .then(
      (output) => JSON.stringify(output),
      (err: unknown) => {
        // A turn that ended before its reply: the engine unreachable, the
        // ledger refusing the run, an unknown conversation, a cancelled turn.
        // This is the ONE owner of the terminal `error` event. The translator
        // deliberately emits none for an `error` part, because a turn that
        // produces one always rejects with the same failure and the client
        // would otherwise see it twice; only here does the failure still
        // carry its code.
        emit({
          type: "error",
          message: err instanceof Error ? err.message : "Stream error",
          code: errorCode(err),
        });
        return "[DONE]";
      },
    )
    .then((terminal) => {
      clearInterval(heartbeat);
      write(`event: done\ndata: ${terminal}\n\n`);
      closed = true;
      try {
        controller.close();
      } catch {
        // Controller may already be closed.
      }
    });

  return new Response(responseStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

/**
 * The failure codes a turn's stream names; any other error carries no code.
 * Read from the error middleware's table, so a turn failure the non-streaming
 * route answers by code is named here too: a hand-kept copy of the list
 * missed `model_call_failed` the day that code was added.
 */
const STREAM_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.keys(ASSISTANT_TURN_ERROR_STATUS),
);

/** The stable code a surface shows, read from the error's shape: a handler refusal's reason, or a turn failure's code. */
function errorCode(err: unknown): string | undefined {
  if (isHandlerError(err)) return err.reason;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && STREAM_ERROR_CODES.has(code)
    ? code
    : undefined;
}
