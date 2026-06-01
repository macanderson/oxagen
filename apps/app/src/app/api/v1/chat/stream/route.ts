import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { streamAgentReply, defaultModel } from "@oxagen/ai";
import { materializeTools, readWorkspaceContext, injectContext } from "@oxagen/agent";
import { db, schema } from "@oxagen/database";
import { randomUUID } from "node:crypto";
import type { CoreMessage } from "ai";
import type { RenderDirective, StreamEvent } from "@/components/chat/stream-event-types";

// Side-effect imports: bind every handler into the shared kernel BEFORE
// materializeTools runs so invoke() can resolve both agent.* and all
// non-agent.* agent-surface capabilities (form.fill, svg.generate, etc.).
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

/**
 * Concrete shapes for the `fullStream` parts we process. We iterate
 * `result.fullStream as AsyncIterable<unknown>` and type-narrow each part
 * via `isStreamPart` rather than relying on the SDK's
 * `TextStreamPart<ToolSet>` generic, which does not resolve the `tool-result`
 * arm to a concrete narrowable shape when TOOLS is the wide `ToolSet` alias.
 */
interface TextDeltaPart { type: "text-delta"; textDelta: string }
interface ToolCallPart { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
interface ToolResultPart { type: "tool-result"; toolCallId: string; toolName: string; result: unknown }
interface FinishPart { type: "finish"; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }

function partType(p: unknown): string | undefined {
  return typeof p === "object" && p !== null && "type" in p
    ? String((p as { type: unknown }).type)
    : undefined;
}

const BodySchema = z.object({
  content: z.string().min(1),
  conversationId: z.string().nullable().default(null),
  parentMessageId: z.string().nullable().default(null),
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
});

// Maximum number of prior messages to include in the context window.
// Keeps prompt size bounded while preserving enough history for coherent
// multi-turn conversations. The newest HISTORY_LIMIT messages are taken
// (ORDER BY createdAt DESC + LIMIT, then reversed in JS so the model sees
// them chronologically oldest→newest).
const HISTORY_LIMIT = 50;

// Valid CoreMessage roles. Guards against malformed DB rows reaching the SDK.
const VALID_ROLES = new Set(["user", "assistant", "system"]);

// POST /api/v1/chat/stream
//
// Streams the agent reply as text/event-stream with StreamEvent payloads.
// Each SSE line has the form:
//   data: <JSON-encoded StreamEvent>\n\n
// followed by a terminal sentinel:
//   event: done\ndata: [DONE]\n\n
//
// The Playwright e2e mock (`e2e/helpers/agent-stream-mock.ts`) intercepts
// this URL and returns a deterministic scripted response so no LLM call
// is made during e2e runs.
//
// This route is the SINGLE LLM caller per turn (OXA-1509). The server
// action (`sendMessageAction`) handles Postgres persistence only — it no
// longer calls the model. History is loaded here directly from the
// messages table, scoped to the resolved workspace and ordered
// deterministically by createdAt.
export async function POST(request: NextRequest): Promise<Response> {
  // Auth: reject unauthenticated requests before consuming the body.
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { content, conversationId, parentMessageId, orgSlug, workspaceSlug } = parsed.data;

  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    tenant = await resolveOrg(orgSlug);
    // Membership gate: any authenticated user can submit a request to any
    // org slug — assert they are actually a member before we touch any
    // org-scoped data (IDOR guard).
    await assertOrgMember(tenant.id, session.user.id);
    workspace = await resolveWorkspace(tenant.id, workspaceSlug);
  } catch {
    return NextResponse.json({ error: "Org or workspace not found" }, { status: 404 });
  }

  // Load full conversation history from Postgres so the model has context
  // for every prior turn. Without this, the model has no memory of prior
  // messages in the conversation (SSE amnesia, OXA-1509).
  //
  // Strategy:
  //   1. If conversationId is provided, load the most-recent HISTORY_LIMIT
  //      rows (DESC + LIMIT) scoped to the resolved workspace, then reverse
  //      to chronological order. The current user message may not yet be
  //      persisted (sendMessageAction runs concurrently), so we always
  //      append it explicitly at the end.
  //   2. If no conversationId yet (first message), skip the DB read — the
  //      coreMessages array will contain only the current user message.
  //
  // Knowledge-graph context injection: readWorkspaceContext is a no-op
  // seam today (returns []) when KNOWLEDGE_GRAPH_ENABLED is not set or
  // Neo4j is not configured. injectContext prepends a system message
  // from blocks only when blocks is non-empty — also a no-op today.
  // Both functions exist so the wiring is in place for the next phase.
  const blocks = await readWorkspaceContext({
    orgId: tenant.id,
    workspaceId: workspace.id,
    userId: session.user.id,
  });

  let historyMessages: CoreMessage[] = [];
  if (conversationId) {
    // Fetch the most-recent HISTORY_LIMIT rows by ordering DESC + LIMIT,
    // then reverse in JS so they end up chronological (oldest→newest). This
    // keeps the prompt size predictable while always retaining recent context.
    const rows = await db()
      .select({
        role: schema.messages.role,
        content: schema.messages.content,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          // Tenant isolation (IDOR guard): conversationId arrives in the
          // request body, so scope the read to the resolved workspace — a
          // member of org A must not be able to pass a conversationId from
          // org B and read its history.
          //
          // INTERIM defense-in-depth. The durable, uniform tenant boundary is
          // Postgres RLS (OXA-1515: ENABLE/FORCE ROW LEVEL SECURITY + policies
          // keyed on current_setting('app.current_org_id'), applied via a
          // withTenant() GUC wrapper). Once RLS lands this predicate is
          // redundant rather than load-bearing; it is kept until then so this
          // path is never conversationId-only in the meantime.
          eq(schema.messages.workspaceId, workspace.id),
        ),
      )
      // Take the most-recent HISTORY_LIMIT rows (DESC + LIMIT), then reverse to
      // chronological order so the model reads them oldest→newest. Ordering ASC
      // with LIMIT would return the OLDEST N rows and drop all recent context.
      .orderBy(desc(schema.messages.createdAt))
      .limit(HISTORY_LIMIT);

    historyMessages = rows
      .filter((r) => VALID_ROLES.has(r.role))
      .map((r) => ({ role: r.role as "user" | "assistant" | "system", content: r.content }))
      .reverse();
  }

  // Append the current user message. sendMessageAction persists this same
  // message concurrently, so depending on which commits first it may ALREADY
  // be the trailing row in `historyMessages`. Only append it when it isn't
  // already there, otherwise the model receives the current turn twice (once
  // from history, once from the explicit append) in the same request.
  const lastHistory = historyMessages[historyMessages.length - 1];
  const currentAlreadyInHistory =
    lastHistory !== undefined &&
    lastHistory.role === "user" &&
    lastHistory.content === content;

  const messagesWithCurrent: CoreMessage[] = currentAlreadyInHistory
    ? historyMessages
    : [...historyMessages, { role: "user", content }];

  // Inject knowledge-graph context as a leading system message (no-op when
  // blocks is empty, which is the default until Neo4j is configured).
  const coreMessages: CoreMessage[] = injectContext(messagesWithCurrent, blocks);

  const requestId = randomUUID();
  const agentTools = await materializeTools({
    orgId: tenant.id,
    workspaceId: workspace.id,
    userId: session.user.id,
    apiKeyId: null,
    requestId,
    surface: "app",
    messageId: parentMessageId ?? requestId,
  });

  const encoder = new TextEncoder();

  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent): void {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      try {
        const result = streamAgentReply({
          messages: coreMessages,
          model: defaultModel(),
          tools: agentTools,
          telemetry: {
            orgId: tenant.id,
            workspaceId: workspace.id,
            surface: "app",
            messageId: parentMessageId ?? requestId,
          },
        });

        // Iterate result.fullStream so we see every event type:
        //   text-delta   → emit "text"
        //   tool-call    → emit "tool-call-start"
        //   tool-result  → emit "tool-call-end" + optional "component" (render directive)
        //   finish       → emit "usage"
        //
        // We iterate as AsyncIterable<unknown> and use partType() to narrow
        // because the SDK's TextStreamPart<ToolSet> generic does not produce a
        // concrete discriminated union when TOOLS is the wide ToolSet alias —
        // the tool-result arm becomes an unresolvable intersection.
        const toolStartedAt: Record<string, number> = {};
        // Accumulate the assistant's text so we can persist the full reply
        // once the stream finishes (see the INSERT after the loop).
        let assistantText = "";

        for await (const raw of result.fullStream as AsyncIterable<unknown>) {
          const pType = partType(raw);
          if (pType === "text-delta") {
            const part = raw as TextDeltaPart;
            assistantText += part.textDelta;
            emit({ type: "text", messageId: requestId, text: part.textDelta });
          } else if (pType === "tool-call") {
            const part = raw as ToolCallPart;
            toolStartedAt[part.toolCallId] = Date.now();
            emit({
              type: "tool-call-start",
              messageId: requestId,
              toolCallId: part.toolCallId,
              capability: part.toolName,
              inputPreview: part.args,
              // Default risk level; capabilities may override via tool metadata.
              riskLevel: "low",
            });
          } else if (pType === "tool-result") {
            const part = raw as ToolResultPart;
            const durationMs =
              toolStartedAt[part.toolCallId] !== undefined
                ? Date.now() - (toolStartedAt[part.toolCallId] as number)
                : 0;
            emit({
              type: "tool-call-end",
              toolCallId: part.toolCallId,
              status: "completed",
              output: part.result,
              durationMs,
            });
            // If the tool result carries a render directive, emit a "component"
            // event so the client renders the typed React component inline.
            const rawResult = part.result;
            if (rawResult !== null && rawResult !== undefined && typeof rawResult === "object") {
              const render = (rawResult as Record<string, unknown>)["render"] as
                | RenderDirective
                | undefined;
              if (
                render !== undefined &&
                typeof render.componentId === "string" &&
                render.props !== null &&
                typeof render.props === "object"
              ) {
                emit({
                  type: "component",
                  toolCallId: part.toolCallId,
                  componentId: render.componentId,
                  props: render.props,
                });
              }
            }
          } else if (pType === "finish") {
            const part = raw as FinishPart;
            // Emit usage so the client can show credits consumed this turn.
            emit({
              type: "usage",
              usage: {
                promptTokens: part.usage.promptTokens ?? 0,
                completionTokens: part.usage.completionTokens ?? 0,
                totalTokens: part.usage.totalTokens ?? 0,
              },
            });
          }
          // step-start, step-finish, tool-call-streaming-start, tool-call-delta,
          // error, reasoning, source — intentionally not forwarded to the client.
        }

        // Persist the assistant reply so it survives a page refresh and is
        // included in the next turn's history (OXA-1509). sendMessageAction
        // already wrote the user message and resolved the conversation; this
        // is the matching assistant row, threaded under the user message.
        // Token usage is metered separately by streamAgentReply.onFinish.
        // Best-effort: a DB failure here must NOT corrupt the SSE response the
        // client already consumed, so it is isolated and only logged.
        if (conversationId && assistantText.length > 0) {
          try {
            const [assistantMsg] = await db()
              .insert(schema.messages)
              .values({
                orgId: tenant.id,
                workspaceId: workspace.id,
                conversationId,
                parentMessageId: parentMessageId ?? undefined,
                role: "assistant",
                content: assistantText,
                contentBlocks: [],
                isActiveInBranch: true,
                metadata: { status: "complete" },
                createdByUserId: session.user.id,
                updatedByUserId: session.user.id,
              })
              .returning({ id: schema.messages.id });
            if (assistantMsg) {
              // Advance the conversation's active leaf to the assistant reply
              // so the next turn threads from here.
              await db()
                .update(schema.conversations)
                .set({ activeLeafMessageId: assistantMsg.id, updatedAt: new Date() })
                .where(eq(schema.conversations.id, conversationId));
            }
          } catch (persistErr) {
            console.error("[chat/stream] failed to persist assistant reply:", persistErr);
          }
        }
      } catch (err) {
        // Surface stream errors as a text event so the client can show them.
        const message = err instanceof Error ? err.message : "Stream error";
        emit({ type: "text", messageId: requestId, text: `\n\n[Error: ${message}]` });
      } finally {
        try {
          controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
        } catch {
          // Controller may already be errored.
        }
        controller.close();
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
