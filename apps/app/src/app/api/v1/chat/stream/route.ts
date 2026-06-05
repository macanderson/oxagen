import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import {
  streamAgentReply,
  selectModel,
  selectImageModel,
  imageTierModelId,
  videoTierModelId,
  generateImageFor,
  supportsReasoning,
  modelIdOf,
} from "@oxagen/ai";
import { materializeTools, readWorkspaceContext, injectContext } from "@oxagen/agent";
import { persistGeneratedAsset, createPendingGeneratedAsset } from "@oxagen/handlers";
import { inngest } from "@oxagen/inngest-functions/client";
import { db, schema } from "@oxagen/database";
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
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
interface TextDeltaPart { type: "text-delta"; text: string }
interface ToolCallPart { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
interface ToolResultPart { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
interface FinishPart { type: "finish"; totalUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }

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
  // Model selection from the prompt's model picker. `tier` is a white-labeled
  // Oxagen text tier (Fast/Balanced/Precise → fast/balanced/precise); `model`
  // is an explicit Vercel AI Gateway model id ("creator/model"). Both optional —
  // when omitted the platform default (balanced tier) is used. `model` wins over
  // `tier`.
  tier: z.enum(["fast", "balanced", "precise"]).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  // Reasoning effort for reasoning-capable models. Forwarded to streamAgentReply
  // only when the resolved model actually supports reasoning (guard below).
  effort: z.enum(["low", "medium", "high"]).nullable().default(null),
  // Media-generation intent. When set, this turn generates an image/video using
  // a media model instead of running the text agent. `mediaModel` is an explicit
  // gateway id; otherwise `mediaTier` (basic/advanced, default basic) resolves
  // one from the OXAGEN_LLM_{IMAGE,VIDEO}_* env.
  generate: z.enum(["image", "video"]).nullable().default(null),
  mediaTier: z.enum(["basic", "advanced"]).nullable().default(null),
  mediaModel: z.string().min(1).nullable().default(null),
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

  const {
    content,
    conversationId,
    parentMessageId,
    orgSlug,
    workspaceSlug,
    tier,
    model,
    effort,
    generate,
    mediaTier,
    mediaModel,
  } = parsed.data;

  // Resolve the language model for this turn from the picker selection. An
  // explicit gateway model id wins; otherwise the white-labeled tier; otherwise
  // selectModel() falls back to the balanced-tier default. selectModel routes
  // through the Vercel AI Gateway when AI_GATEWAY_API_KEY is configured.
  const turnModel = selectModel({
    ...(model ? { model } : tier ? { tier } : {}),
  });

  // Reasoning effort is only valid on reasoning-capable models. The picker
  // already gates the control, but re-check server-side against the catalog
  // (keyed by the resolved gateway model id) so a stray `effort` for a
  // non-reasoning model is dropped rather than forwarded and rejected upstream.
  const turnEffort =
    effort && supportsReasoning(modelIdOf(turnModel)) ? effort : undefined;

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

  // ── Media-generation branch ───────────────────────────────────────────────
  //
  // When the composer requests image/video generation, this turn does NOT run
  // the text agent. It resolves the media model (explicit `mediaModel`, else the
  // basic/advanced tier from env) and generates, uploads the result to blob
  // storage + a `content.generated_assets` row (access policy "org" so org
  // teammates viewing the conversation can see it), then emits a `component`
  // event the chat registry renders inline via the access-controlled serving
  // route (image-preview / make-video-form).
  if (generate) {
    const mediaResponse = streamMediaGeneration({
      kind: generate,
      prompt: content,
      mediaModel,
      mediaTier: mediaTier ?? "basic",
      userId: session.user.id,
      conversationId,
      messageId: parentMessageId,
      telemetry: {
        orgId: tenant.id,
        workspaceId: workspace.id,
        executionStepId: parentMessageId ?? randomUUID(),
      },
    });
    return mediaResponse;
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

  let historyMessages: ModelMessage[] = [];
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

  const messagesWithCurrent: ModelMessage[] = currentAlreadyInHistory
    ? historyMessages
    : [...historyMessages, { role: "user", content }];

  // Inject knowledge-graph context as a leading system message (no-op when
  // blocks is empty, which is the default until Neo4j is configured).
  const coreMessages: ModelMessage[] = injectContext(messagesWithCurrent, blocks);

  const requestId = randomUUID();
  // materializeTools returns the AI SDK tool map keyed by *model-safe* names
  // (the gateway rejects the dotted capability names — see toModelToolName)
  // plus a reverse map back to the real capability name. The map translates
  // tool-call stream events so the UI still shows/routes on the real name.
  const { tools: agentTools, nameMap: toolNameMap } = await materializeTools({
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
          model: turnModel,
          tools: agentTools,
          ...(turnEffort ? { effort: turnEffort } : {}),
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
            assistantText += part.text;
            emit({ type: "text", messageId: requestId, text: part.text });
          } else if (pType === "tool-call") {
            const part = raw as ToolCallPart;
            toolStartedAt[part.toolCallId] = Date.now();
            emit({
              type: "tool-call-start",
              messageId: requestId,
              toolCallId: part.toolCallId,
              // Translate the model-safe tool name back to the real dotted
              // capability name so the UI labels and routes (e.g.
              // agent.code.execute → CodeExecuteCard) on the real name.
              capability: toolNameMap[part.toolName] ?? part.toolName,
              inputPreview: part.input,
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
              output: part.output,
              durationMs,
            });
            // If the tool result carries a render directive, emit a "component"
            // event so the client renders the typed React component inline.
            const rawResult = part.output;
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
                promptTokens: part.totalUsage.inputTokens ?? 0,
                completionTokens: part.totalUsage.outputTokens ?? 0,
                totalTokens: part.totalUsage.totalTokens ?? 0,
              },
            });
          } else if (pType === "error") {
            // streamText surfaces provider/gateway failures (e.g. a 400 from a
            // bad request, auth, or rate limit) as an `error` PART rather than
            // throwing — iterating fullStream never rejects. If we don't
            // forward it the turn produces zero output and the user sees
            // nothing at all. Surface it as a text event (same shape the outer
            // catch uses) so the failure is visible instead of silent.
            const errVal = (raw as { error?: unknown }).error;
            const message =
              errVal instanceof Error
                ? errVal.message
                : typeof errVal === "string"
                  ? errVal
                  : "Stream error";
            // Show the failure live but do NOT fold it into assistantText —
            // persisting "[Error: …]" as the assistant reply would feed the
            // error back into the next turn's history context.
            emit({ type: "text", messageId: requestId, text: `\n\n[Error: ${message}]` });
          }
          // step-start, step-finish, tool-call-streaming-start, tool-call-delta,
          // reasoning, source — intentionally not forwarded to the client.
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

// Stream a media-generation turn as text/event-stream, mirroring the text path's
// SSE framing (data: <StreamEvent>\n\n … event: done\ndata: [DONE]\n\n) so the
// client's `useToolStream` consumes both paths identically.
//
//  - image: resolve the media model (explicit id or basic/advanced tier), call
//    the @oxagen/ai image chokepoint (telemetry + billing live inside it), and
//    emit a `component` event the registry renders via "image-preview".
//  - video: there is no AI SDK v4 video primitive yet, so this is a wired stub
//    (per the documented stub policy): it resolves the configured video model
//    for the record and emits the existing "make-video-form" component, whose
//    bound server action returns a queued result. Tracked for the real pipeline.
function streamMediaGeneration(args: {
  kind: "image" | "video";
  prompt: string;
  mediaModel: string | null;
  mediaTier: "basic" | "advanced";
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  telemetry: { orgId: string; workspaceId: string; executionStepId: string };
}): Response {
  const encoder = new TextEncoder();
  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent): void {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      const toolCallId = randomUUID();
      try {
        if (args.kind === "image") {
          const modelId =
            args.mediaModel ?? imageTierModelId(args.mediaTier);
          const imageModel = selectImageModel({ model: modelId });
          try {
            const { images } = await generateImageFor({
              model: imageModel,
              prompt: args.prompt,
              n: 1,
              size: "1024x1024",
              telemetry: {
                orgId: args.telemetry.orgId,
                workspaceId: args.telemetry.workspaceId,
                surface: "app",
                executionStepId: args.telemetry.executionStepId,
              },
            });
            const b64 = images[0];
            if (!b64) {
              emit({
                type: "component",
                toolCallId,
                componentId: "image-preview",
                props: { placeholder: true, prompt: args.prompt, alt: args.prompt },
              });
            } else {
              // Persist to blob storage + a generated_assets row, then render via
              // the access-controlled serving route (never the raw blob URL).
              const asset = await persistGeneratedAsset({
                orgId: args.telemetry.orgId,
                workspaceId: args.telemetry.workspaceId,
                userId: args.userId,
                kind: "image",
                accessPolicy: "org",
                bytes: Buffer.from(b64, "base64"),
                mimeType: "image/png",
                prompt: args.prompt,
                model: modelId,
                conversationId: args.conversationId,
                messageId: args.messageId,
              });
              emit({
                type: "component",
                toolCallId,
                componentId: "image-preview",
                props: { url: asset.serveUrl, alt: args.prompt },
              });
            }
          } catch (genErr) {
            // Generation failed (no key / unsupported model / provider error):
            // render the image-preview empty-state with the reason instead of
            // failing the turn.
            const reason =
              genErr instanceof Error ? genErr.message : "Generation failed";
            emit({
              type: "component",
              toolCallId,
              componentId: "image-preview",
              props: {
                placeholder: true,
                prompt: args.prompt,
                alt: args.prompt,
                errorReason: reason,
              },
            });
          }
        } else {
          // video — asynchronous render. Veo renders take minutes, so we don't
          // block the request: create a pending generated_assets row, dispatch
          // the `agent/video.render` Inngest job (which generates, uploads to
          // blob, and flips the row to `ready`), and emit a video-result
          // component that polls the serving route until the asset is ready.
          const modelId = args.mediaModel ?? videoTierModelId(args.mediaTier);
          const pending = await createPendingGeneratedAsset({
            orgId: args.telemetry.orgId,
            workspaceId: args.telemetry.workspaceId,
            userId: args.userId,
            kind: "video",
            accessPolicy: "org",
            mimeType: "video/mp4",
            prompt: args.prompt,
            model: modelId,
            conversationId: args.conversationId,
            messageId: args.messageId,
          });
          await inngest.send({
            name: "agent/video.render",
            data: {
              assetId: pending.id,
              orgId: args.telemetry.orgId,
              workspaceId: args.telemetry.workspaceId,
              userId: args.userId,
              prompt: args.prompt,
              model: modelId,
              mediaTier: args.mediaTier,
            },
          });
          emit({
            type: "component",
            toolCallId,
            componentId: "video-result",
            props: { url: pending.serveUrl, prompt: args.prompt },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Generation error";
        emit({
          type: "text",
          messageId: toolCallId,
          text: `\n\n[Error: ${message}]`,
        });
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
