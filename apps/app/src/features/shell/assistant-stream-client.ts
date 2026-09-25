// The assistant flyout's stream client (ADR-176). A turn streams from the
// API's `POST /v1/:org/:ws/chat/stream`, the one SSE transport of the in-app
// agent. The browser reaches it same-origin through the app's `/api/v1/*`
// rewrite (next.config.ts), so the session cookie travels and no second
// transport is added. The Run page follows its runs the same way
// (features/run/use-run-stream.ts).
//
// The route invokes `ask_assistant` through the kernel, as the Server Action
// did, so the turn passes the same gates, is recorded as the same `chat` run,
// and refuses with the same codes.
//
// It is a fetch, not a Server Action. Next.js dispatches Server Actions one at
// a time per client, so a turn of up to six minutes held every other action
// in the app, an approval or a notification, behind it. A fetch runs beside
// them.
//
// The wire is the route's own (apps/api chat-stream-translator.ts): `data:`
// lines of typed events, a `: keep-alive` comment while the turn is quiet, and
// a terminal `event: done` whose data is the ask_assistant output, or
// `[DONE]` after an `error` event. A refusal before the turn is prepared is
// not a stream at all: it is a JSON error envelope with the status
// `POST /assistant/ask` answers.
//
// Every way a turn ends is answered in the shape the Server Action answered
// it (`ActionResult<AssistantTurn>`), classified by the codes the kernel seam
// classifies (server/kernel.ts), so the flyout's refusal sentences read the
// same whichever way a refusal arrived. One outcome is new: `dropped`, a
// stream that ended before its terminal. A dropped connection does not stop
// the turn (ADR-092), so the flyout keeps what arrived and offers to load the
// finished reply from the run.
import { z } from "zod";
import type { ActionResult } from "@/server/kernel";

/** A governed write the turn parked, waiting on a person. */
export type ParkedCard = {
  approvalId: string;
  capability: string;
  expiresAt: string;
};

type AssistantTurn = {
  conversationId: string;
  /** `arun_…`: the run this turn was recorded as; the Run page opens it. */
  runId: string;
  reply: string;
  parkedCards: readonly ParkedCard[];
};

/** A refusal, in the shape the kernel seam gives one. */
export type AssistantRefusal = Extract<
  ActionResult<AssistantTurn>,
  { ok: false }
>;

/** The stream ended before its terminal. The turn itself ran on. */
type AssistantStreamDropped = {
  ok: false;
  reason: "dropped";
  /** The run the stream named before it dropped; null when it named none. */
  runId: string | null;
};

export type AssistantStreamResult =
  | ActionResult<AssistantTurn>
  | AssistantStreamDropped;

/** What the person asked, and where they were standing when they asked it. */
export type AssistantQuestion = {
  conversationId: string | null;
  content: string;
  route: string | null;
  entityId: string | null;
  /**
   * The name the page gave the record `entityId` names (a run's title, a
   * runtime's hostname), so the agent can cite the record the way the person
   * sees it. The caller cuts it to the contract's cap (`page-label.ts`). The
   * turn strips its control characters and quotes it as a label beside the
   * id. Absent or null sends none.
   */
  entityLabel?: string | null;
};

/** A tool call the turn made, named by the capability it called. */
type StreamedToolCall = { id: string; capability: string };

/** What the flyout hears while the turn runs. Every handler is optional. */
export type AssistantStreamHandlers = {
  /** The run the turn was admitted as, before the engine is asked anything. */
  onRun?: (runId: string) => void;
  /** The next fragment of the reply. */
  onText?: (delta: string) => void;
  onToolStart?: (call: StreamedToolCall) => void;
  onToolEnd?: (call: { id: string; status: "completed" | "failed" }) => void;
  /** A governed write the turn parked, waiting on a person. */
  onParked?: (card: ParkedCard) => void;
};

/**
 * The capability a per-turn budget pause is filed under
 * (`BUDGET_CONTINUE_CAPABILITY`, packages/agent assistant-turn.ts). The turn
 * waits on it before it goes on, and the handler leaves it out of
 * `parkedCards`, so it is not a parked write here either.
 */
const BUDGET_CONTINUE_CAPABILITY = "budget.turn.continue";

type ExhaustedCode = Extract<AssistantRefusal, { reason: "exhausted" }>["code"];

/** The kernel seam's exhausted codes (server/kernel.ts `EXHAUSTED_CODES`). */
const EXHAUSTED_CODES: readonly ExhaustedCode[] = [
  "gau_exhausted",
  "billing_suspended",
  "budget_exceeded",
  "insufficient_credits",
  "assistant_spend_cap",
  "assistant_model_key_limit",
];

const isExhaustedCode = (code: string): code is ExhaustedCode =>
  EXHAUSTED_CODES.some((known) => known === code);

/**
 * The code the kernel seam gives a failure it cannot classify
 * (server/kernel.ts), used here for an `error` event that carries no code.
 */
const UNCLASSIFIED = "kernel_failure";

/**
 * A failure the route named after the stream opened, classified as the kernel
 * seam classifies the same code. The route names a handler refusal by its
 * reason, so `conversation_not_found` is the not-found it was on the seam.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function refusalOfCode(code: string | undefined): AssistantRefusal {
  if (code === undefined) {
    return { ok: false, reason: "unavailable", code: UNCLASSIFIED };
  }
  if (isExhaustedCode(code)) return { ok: false, reason: "exhausted", code };
  if (code === "engine_aborted") return { ok: false, reason: "conflict", code };
  if (code === "conversation_not_found") {
    return { ok: false, reason: "not_found", code };
  }
  if (
    code === "no_principal" ||
    code === "org_role_required" ||
    code === "kill_switch"
  ) {
    return { ok: false, reason: "denied", code };
  }
  return { ok: false, reason: "unavailable", code };
}

const envelopeSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.string().optional(),
      reason: z.string().optional(),
      accessRequestId: z.string().optional(),
    }),
  ]),
});

/**
 * A refusal the route answered before the stream opened: the error
 * middleware's envelope and its status. The status carries the kind and the
 * envelope the code, the handler's reason first, as on the kernel seam.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function refusalOfResponse(
  status: number,
  body: unknown,
): AssistantRefusal {
  const parsed = envelopeSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : null;
  const named =
    error === null || typeof error === "string"
      ? null
      : (error.reason ?? error.code ?? null);
  switch (status) {
    case 400:
      return { ok: false, reason: "invalid", code: "invalid_input" };
    case 401:
      return { ok: false, reason: "denied", code: "unauthorized" };
    case 402:
      return named !== null && isExhaustedCode(named)
        ? { ok: false, reason: "exhausted", code: named }
        : { ok: false, reason: "unavailable", code: named ?? UNCLASSIFIED };
    case 403: {
      if (
        error !== null &&
        typeof error !== "string" &&
        error.code === "pending_approval" &&
        error.accessRequestId !== undefined
      ) {
        return {
          ok: false,
          reason: "pending_approval",
          accessRequestId: error.accessRequestId,
        };
      }
      return { ok: false, reason: "denied", code: named ?? "authz_denied" };
    }
    case 404:
      return { ok: false, reason: "not_found", code: named ?? "not_found" };
    case 409:
      return { ok: false, reason: "conflict", code: named ?? "conflict" };
    case 429:
      return { ok: false, reason: "unavailable", code: "rate_limited" };
    default:
      return {
        ok: false,
        reason: "unavailable",
        code: named ?? UNCLASSIFIED,
      };
  }
}

const parkedCardSchema = z.object({
  approvalId: z.string(),
  capability: z.string(),
  expiresAt: z.string(),
});

/** The terminal's data: ask_assistant's output, read for what the flyout shows. */
const turnSchema = z.object({
  conversationId: z.string(),
  runId: z.string(),
  reply: z.string(),
  parkedCards: z.array(parkedCardSchema),
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run"), runId: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool-call-start"),
    toolCallId: z.string(),
    capability: z.string(),
  }),
  z.object({
    type: z.literal("tool-call-end"),
    toolCallId: z.string(),
    status: z.enum(["completed", "failed"]),
  }),
  parkedCardSchema.extend({ type: z.literal("approval-required") }),
  z.object({ type: z.literal("error"), code: z.string().optional() }),
]);

/** One SSE message: its `event:` name, or null for the default, and its data. */
type SseMessage = { event: string | null; data: string };

/**
 * The messages of an SSE body, in order. A comment line (`: keep-alive`)
 * carries no data and is skipped, and a message split across two network
 * chunks is joined before it is read.
 */
async function* sseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const message = parseMessage(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (message !== null) yield message;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseMessage(block: string): SseMessage | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The route for a workspace: same-origin, through the `/api/v1/*` rewrite. */
function assistantStreamUrl(org: string, ws: string): string {
  return `/api/v1/${encodeURIComponent(org)}/${encodeURIComponent(ws)}/chat/stream`;
}

/**
 * Ask the in-app agent one question inside `ws` and follow the turn as it is
 * written.
 *
 * `conversationId` null opens a new conversation; the id that comes back
 * continues it. `route` is where the person was standing when they asked. The
 * agent is being asked about what is on screen, so the page travels with the
 * question.
 *
 * Never rejects: a network failure before the stream opens is `unavailable`,
 * and one after it is `dropped`.
 */
export async function askAssistantStream(
  org: string,
  ws: string,
  question: AssistantQuestion,
  on: AssistantStreamHandlers = {},
): Promise<AssistantStreamResult> {
  let response: Response;
  try {
    response = await fetch(assistantStreamUrl(org, ws), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        conversationId: question.conversationId,
        content: question.content,
        pageContext:
          question.route === null
            ? null
            : {
                route: question.route,
                orgSlug: org,
                workspaceSlug: ws,
                entityId: question.entityId,
                entityLabel: question.entityLabel ?? null,
              },
      }),
    });
  } catch {
    return { ok: false, reason: "unavailable", code: "network_error" };
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    return refusalOfResponse(response.status, body);
  }
  if (response.body === null) {
    return { ok: false, reason: "unavailable", code: "stream_unreadable" };
  }

  let runId: string | null = null;
  let failure: AssistantRefusal | null = null;
  try {
    for await (const message of sseMessages(response.body)) {
      if (message.event === "done") {
        if (failure !== null) return failure;
        const turn = turnSchema.safeParse(parseJson(message.data));
        return turn.success
          ? { ok: true, value: turn.data }
          : {
              ok: false,
              reason: "unavailable",
              code: "contract_output_mismatch",
            };
      }
      const event = eventSchema.safeParse(parseJson(message.data));
      // Reasoning, steps, usage and budget notices are not drawn here.
      if (!event.success) continue;
      const e = event.data;
      switch (e.type) {
        case "run":
          runId = e.runId;
          on.onRun?.(e.runId);
          break;
        case "text":
          on.onText?.(e.text);
          break;
        case "tool-call-start":
          on.onToolStart?.({ id: e.toolCallId, capability: e.capability });
          break;
        case "tool-call-end":
          on.onToolEnd?.({ id: e.toolCallId, status: e.status });
          break;
        case "approval-required":
          if (e.capability !== BUDGET_CONTINUE_CAPABILITY) {
            on.onParked?.({
              approvalId: e.approvalId,
              capability: e.capability,
              expiresAt: e.expiresAt,
            });
          }
          break;
        case "error":
          failure ??= refusalOfCode(e.code);
          break;
      }
    }
  } catch {
    // The connection broke mid-stream. What arrived stays with the caller.
  }
  // A turn that named its failure has ended, whether or not its terminal
  // arrived. Anything else that ends early is a dropped stream.
  return failure ?? { ok: false, reason: "dropped", runId };
}
