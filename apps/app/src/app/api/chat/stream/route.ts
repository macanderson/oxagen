import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { streamAgentReply, defaultModel } from "@oxagen/ai";
import { materializeTools, readWorkspaceContext, injectContext } from "@oxagen/agent";
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

// POST /api/chat/stream
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
// Persistence is handled separately by `sendMessageAction` (server
// action). This route is responsible only for the real-time stream.
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

  const { content, parentMessageId, orgSlug, workspaceSlug } = parsed.data;

  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    tenant = await resolveOrg(orgSlug);
    workspace = await resolveWorkspace(tenant.id, workspaceSlug);
  } catch {
    return NextResponse.json({ error: "Org or workspace not found" }, { status: 404 });
  }

  // Build a minimal message context from the current user message only.
  // The full conversation history is managed by the server action
  // (`sendMessageAction`) which owns the Postgres write; here we just
  // need enough context for the streaming model call.
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
  const coreMessages: CoreMessage[] = injectContext([{ role: "user", content }], blocks);

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

        for await (const raw of result.fullStream as AsyncIterable<unknown>) {
          const pType = partType(raw);
          if (pType === "text-delta") {
            const part = raw as TextDeltaPart;
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
