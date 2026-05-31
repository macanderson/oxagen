import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { streamAgentReply, defaultModel } from "@oxagen/ai";
import { materializeTools } from "@oxagen/agent";
import { randomUUID } from "node:crypto";
import type { CoreMessage } from "ai";
import type { StreamEvent } from "@/components/chat/stream-event-types";

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
  const coreMessages: CoreMessage[] = [{ role: "user", content }];

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

        for await (const chunk of result.textStream) {
          emit({ type: "text", messageId: requestId, text: chunk });
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
