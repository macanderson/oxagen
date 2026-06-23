import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import {
  streamAgentReply,
  selectModel,
  supportsReasoning,
  modelIdOf,
  loadEffectiveModelDefaults,
  resolvePrompt,
  chatSystemPrompt,
  loadWorkspacePromptConfig,
  tool,
  type ToolSet,
  type ModelMessage,
} from "@oxagen/ai";
import { materializeTools, readWorkspaceContext, injectContext } from "@oxagen/agent";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import { formFill } from "@oxagen/oxagen/contracts/form.fill";
import { fieldDescriptorSchema } from "@oxagen/oxagen/contracts/form.fill";
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@/components/chat/stream-event-types";
import { autoTitleConversation } from "./auto-title";
import { streamMediaGeneration } from "./media-generation";
import { translateAgentStream } from "./translate-stream";

// Side-effect imports: bind every handler into the shared kernel BEFORE
// materializeTools runs so invoke() can resolve both agent.* and all
// non-agent.* agent-surface capabilities (form.fill, svg.generate, etc.).
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

const BodySchema = z.object({
  // Bound the message body: an unbounded `content` lets a single authed request
  // forward an arbitrarily large prompt to the LLM, driving unbounded metering
  // cost and blowing the per-turn token budget. 32 KiB is generous for a chat
  // turn while capping abuse.
  content: z.string().min(1).max(32_768),
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
  // True when the client created this conversation on this turn (first message).
  // Used to trigger auto-title generation after the assistant replies.
  newConversation: z.boolean().default(false),
  // Per-turn MCP server allowlist: publicIds of servers the user has activated
  // in the chat composer. When non-empty, only those servers' tools are loaded.
  activeServerIds: z.array(z.string()).optional().default([]),
  // Optional page context forwarded from the client at send-time. Carries the
  // current route and, when a fillable form is registered, its field list so
  // the agent can propose fill values via the `page_form_fill` tool.
  // Null / absent when no form is registered (ask/chat full pages, etc.).
  pageContext: z
    .object({
      route: z.string().min(1).max(2048),
      entitySummary: z.string().max(500).optional(),
      fillableForm: z
        .object({
          formId: z.string().min(1).max(256),
          title: z.string().min(1).max(256),
          // Hard cap: 60 fields, each string capped to 256 chars.
          fields: z
            .array(
              fieldDescriptorSchema.extend({
                name: z.string().min(1).max(256),
                label: z.string().min(1).max(256),
              }),
            )
            .max(60),
        })
        .optional(),
    })
    .nullable()
    .default(null),
});

// Maximum number of prior messages to include in the context window. Keeps
// prompt size bounded while preserving enough history for coherent multi-turn
// conversations. The newest HISTORY_LIMIT messages are taken (DESC + LIMIT,
// then reversed so the model sees them chronologically oldest→newest).
const HISTORY_LIMIT = 50;

// Valid CoreMessage roles. Guards against malformed DB rows reaching the SDK.
const VALID_ROLES = new Set(["user", "assistant", "system"]);

// POST /api/v1/chat/stream
//
// Streams the agent reply as text/event-stream with StreamEvent payloads. Each
// SSE line has the form `data: <JSON StreamEvent>\n\n` followed by a terminal
// `event: done\ndata: [DONE]\n\n` sentinel.
//
// The Playwright e2e mock (`e2e/helpers/agent-stream-mock.ts`) intercepts this
// URL and returns a deterministic scripted response so no LLM call is made
// during e2e runs.
//
// This route is the SINGLE LLM caller per turn (OXA-1509). The server action
// (`sendMessageAction`) handles Postgres persistence only — it no longer calls
// the model. History is loaded here directly from the messages table, scoped to
// the resolved workspace and ordered deterministically by createdAt.
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
    newConversation,
    activeServerIds,
    pageContext,
  } = parsed.data;

  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    tenant = await resolveOrg(orgSlug);
    // Membership gate: any authenticated user can submit a request to any org
    // slug — assert they are actually a member before we touch any org-scoped
    // data (IDOR guard).
    await assertOrgMember(tenant.id, session.user.id);
    workspace = await resolveWorkspace(tenant.id, workspaceSlug);
  } catch {
    return NextResponse.json({ error: "Org or workspace not found" }, { status: 404 });
  }

  // Resolve the language model for this turn from the picker selection. An
  // explicit gateway model id wins; otherwise the white-labeled tier; otherwise
  // fall back to the effective workspace/user defaults (safety net for direct
  // API callers that omit both); finally selectModel() falls back to the
  // balanced-tier system default.
  let resolvedModel = model;
  let resolvedTier = tier;
  if (!resolvedModel && !resolvedTier) {
    // Best-effort: ignore errors so a missing prefs row never breaks the turn.
    try {
      const defaults = await loadEffectiveModelDefaults({
        userId: session.user.id,
        workspaceId: workspace.id,
      });
      resolvedModel = defaults.text.model;
      resolvedTier = defaults.text.tier;
    } catch {
      // Fall through to system default inside selectModel().
    }
  }

  const turnModel = selectModel({
    ...(resolvedModel ? { model: resolvedModel } : resolvedTier ? { tier: resolvedTier } : {}),
  });

  // Reasoning effort is only valid on reasoning-capable models. Re-check
  // server-side against the catalog (keyed by the resolved gateway model id) so
  // a stray `effort` for a non-reasoning model is dropped rather than forwarded.
  const turnEffort = effort && supportsReasoning(modelIdOf(turnModel)) ? effort : undefined;

  // ── Media-generation branch ───────────────────────────────────────────────
  // When the composer requests image/video generation, this turn does NOT run
  // the text agent. Resolve the media model (explicit per-turn → effective
  // workspace/user default → tier default inside streamMediaGeneration).
  if (generate) {
    let resolvedMediaModel = mediaModel;
    if (!resolvedMediaModel) {
      try {
        const mediaDefaults = await loadEffectiveModelDefaults({
          userId: session.user.id,
          workspaceId: workspace.id,
        });
        resolvedMediaModel =
          generate === "image"
            ? (mediaDefaults.image.model ?? null)
            : (mediaDefaults.video.model ?? null);
      } catch {
        // Fall through to tier default inside streamMediaGeneration.
      }
    }
    return streamMediaGeneration({
      kind: generate,
      prompt: content,
      mediaModel: resolvedMediaModel,
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
  }

  // Load conversation history from Postgres so the model has context for every
  // prior turn (without this the model has SSE amnesia, OXA-1509).
  //
  // Knowledge-graph context injection: readWorkspaceContext is a no-op seam
  // today (returns []) when KNOWLEDGE_GRAPH_ENABLED is not set or Neo4j is not
  // configured; injectContext prepends a system message only when blocks is
  // non-empty. Both exist so the wiring is in place for the next phase.
  const contextBlocks = await readWorkspaceContext({
    orgId: tenant.id,
    workspaceId: workspace.id,
    userId: session.user.id,
  });

  let historyMessages: ModelMessage[] = [];
  if (conversationId) {
    // Fetch the most-recent HISTORY_LIMIT rows (DESC + LIMIT), then reverse in
    // JS so they end up chronological (oldest→newest). ASC + LIMIT would return
    // the OLDEST N rows and drop all recent context.
    //
    // Tenant isolation: wrapped in runInTenantScope + withTenantDb so the
    // Postgres RLS policies (OXA-1515) enforce isolation at the DB layer. The
    // eq(orgId)/eq(workspaceId) predicates are belt-and-suspenders planner hints.
    const rows = await runInTenantScope(
      { orgId: tenant.id, workspaceId: workspace.id },
      () =>
        withTenantDb((tx) =>
          tx
            .select({
              role: schema.messages.role,
              content: schema.messages.content,
            })
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.conversationId, conversationId),
                eq(schema.messages.orgId, tenant.id),
                eq(schema.messages.workspaceId, workspace.id),
              ),
            )
            .orderBy(desc(schema.messages.createdAt))
            .limit(HISTORY_LIMIT),
        ),
    );

    historyMessages = rows
      .filter((r) => VALID_ROLES.has(r.role) && r.content.trim().length > 0)
      .map((r) => ({ role: r.role as "user" | "assistant" | "system", content: r.content }))
      .reverse();
  }

  // Append the current user message unless sendMessageAction (running
  // concurrently) already persisted it as the trailing row — otherwise the
  // model would receive the current turn twice in the same request.
  const lastHistory = historyMessages[historyMessages.length - 1];
  const currentAlreadyInHistory =
    lastHistory !== undefined && lastHistory.role === "user" && lastHistory.content === content;

  const messagesWithCurrent: ModelMessage[] = currentAlreadyInHistory
    ? historyMessages
    : [...historyMessages, { role: "user", content }];

  // Inject knowledge-graph context as a leading system message (no-op when
  // blocks is empty, the default until Neo4j is configured).
  const coreMessages: ModelMessage[] = injectContext(messagesWithCurrent, contextBlocks);

  const requestId = randomUUID();

  // Extract client IP for IAM ip_ranges condition evaluation. x-forwarded-for
  // is set by Vercel/Next.js edge; take the first hop (leftmost = original
  // client), fall back to x-real-ip, then null.
  // SECURITY: used only for IAM condition evaluation, never authentication.
  const xffRaw = request.headers.get("x-forwarded-for");
  const clientIp: string | null =
    (xffRaw ? xffRaw.split(",")[0]?.trim() || null : null) ??
    request.headers.get("x-real-ip")?.trim() ??
    null;

  const encoder = new TextEncoder();

  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent): void {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      try {
        // materializeTools is called inside start() so emit() is already live
        // when onApprovalRequired fires. runInTenantScope is required:
        // contributeMcpTools reads workspace MCP server listings via
        // withTenantDb, which needs an active ALS tenant scope.
        // Materialize tools AND load the workspace prompt config in the same
        // tenant scope, in parallel — both read tenant-scoped tables via
        // withTenantDb and need an active ALS scope. The prompt config lets a
        // workspace append "additional instructions" to the (append-only) core
        // chat prompt; a load failure degrades to the untouched baseline.
        const capCtx = {
          orgId: tenant.id,
          workspaceId: workspace.id,
          userId: session.user.id,
          apiKeyId: null as string | null,
          requestId,
          surface: "app" as const,
          messageId: parentMessageId ?? requestId,
          clientIp,
        };

        const [{ tools: agentTools, nameMap: toolNameMap }, promptConfig] =
          await runInTenantScope({ orgId: tenant.id, workspaceId: workspace.id }, () =>
            Promise.all([
              materializeTools(
                capCtx,
                {
                  serverAllowlist: activeServerIds.length > 0 ? new Set(activeServerIds) : undefined,
                  onApprovalRequired: (approvalEvent) => {
                    emit({
                      type: "approval-required",
                      approvalId: approvalEvent.approvalId,
                      capability: approvalEvent.capability,
                      inputPreview: approvalEvent.inputPreview,
                      riskLevel: approvalEvent.riskLevel,
                      expiresAt: approvalEvent.expiresAt,
                    });
                  },
                },
              ),
              loadWorkspacePromptConfig(workspace.id).catch(() => ({})),
            ]),
          );

        // ── Page-form-fill tool (request-scoped) ────────────────────────────
        // When the client sends a fillableForm in pageContext, register a
        // request-scoped `page_form_fill` tool that routes through the
        // kernel.invoke() boundary (IAM + metering). The tool is NOT part of
        // materializeTools — it is assembled here against the live pageContext
        // fields so the handler closure captures the exact field list.
        let pageFormFillTool: ToolSet | undefined;
        let pageFormFillSystemSuffix = "";

        if (pageContext?.fillableForm) {
          const { route: pcRoute, entitySummary: pcEntitySummary } = pageContext;
          const { formId: pcFormId, title: pcFormTitle, fields: pcFields } = pageContext.fillableForm;

          // Build a compact field list for the system prompt.
          const fieldLines = pcFields.map((f) => {
            const optPart =
              f.options && f.options.length > 0
                ? ` options=[${f.options.map((o) => `"${o.label}"`).join(", ")}]`
                : "";
            const reqPart = f.required ? " required" : "";
            const curPart = f.current !== null && f.current !== undefined && f.current !== ""
              ? ` current="${String(f.current)}"`
              : "";
            return `  - ${f.name} (${f.label}) type=${f.type}${reqPart}${curPart}${optPart}`;
          });

          pageFormFillSystemSuffix = [
            "",
            "---",
            "",
            "## Current page form",
            "",
            `Route: ${pcRoute}`,
            ...(pcEntitySummary ? [`Entity: ${pcEntitySummary}`] : []),
            `Form: "${pcFormTitle}" (id: ${pcFormId})`,
            "Fields:",
            ...fieldLines,
            "",
            "**Behavior rules for form fill:**",
            "- When the user asks to fill, update, or change this form, call the `page_form_fill` tool with a clear natural-language instruction.",
            "- If the request is ambiguous (you cannot determine which field or what value without guessing), **ask a clarifying question** instead of calling the tool — never call `page_form_fill` with invented values.",
            "- After the tool returns, briefly summarize the proposed changes and tell the user to review the suggestion panel. The proposals do NOT apply until the user accepts them.",
          ].join("\n");

          pageFormFillTool = {
            page_form_fill: tool({
              description:
                "Fill or suggest values for the page form the user is currently viewing. " +
                "Call this when the user asks to fill, update, or change the form. " +
                "Pass a clear natural-language instruction describing the desired changes. " +
                "If the request is ambiguous, ask a clarifying question instead.",
              inputSchema: z.object({
                instruction: z.string().min(1).describe(
                  "Natural-language instruction describing the desired form changes.",
                ),
              }),
              execute: async (input: { instruction: string }) => {
                const { instruction } = input;
                const rawResult = await invoke(
                  "form.fill",
                  {
                    route: pcRoute,
                    entitySummary: pcEntitySummary,
                    instruction,
                    fields: pcFields.map((f) => ({
                      name: f.name,
                      label: f.label,
                      type: f.type,
                      current: f.current,
                      options: f.options,
                      required: f.required,
                    })),
                  },
                  capCtx,
                  { surface: "agent" },
                );
                return formFill.output.parse(rawResult);
              },
            }),
          };
        }

        // Merge the page_form_fill tool (when present) alongside the
        // materialized agent tools. The toolNameMap does not need an entry for
        // page_form_fill — translate-stream.ts already falls back to
        // toolNameMap[name] ?? name so it will display as "page_form_fill".
        const allTools = pageFormFillTool
          ? { ...agentTools, ...pageFormFillTool }
          : agentTools;

        const result = streamAgentReply({
          messages: coreMessages,
          model: turnModel,
          tools: allTools,
          system: resolvePrompt({
            key: "chat.system",
            baseline:
              chatSystemPrompt({
                orgSlug,
                workspaceSlug,
                orgName: tenant.name,
                workspaceName: workspace.name,
              }) + pageFormFillSystemSuffix,
            config: promptConfig,
          }),
          ...(turnEffort ? { effort: turnEffort } : {}),
          telemetry: {
            orgId: tenant.id,
            workspaceId: workspace.id,
            surface: "app",
            messageId: parentMessageId ?? requestId,
          },
        });

        // Consume fullStream: emit SSE events + accumulate the ordered assistant
        // content blocks for refresh re-render and history.
        const { assistantText, persistedBlocks } = await translateAgentStream({
          fullStream: result.fullStream as AsyncIterable<unknown>,
          requestId,
          toolNameMap,
          orgSlug,
          workspaceSlug,
          modelId: modelIdOf(turnModel),
          emit,
        });

        // Persist the assistant reply so it survives a refresh and is included
        // in the next turn's history (OXA-1509). Best-effort: a DB failure here
        // must NOT corrupt the SSE response the client already consumed.
        if (conversationId && (assistantText.length > 0 || persistedBlocks.length > 0)) {
          try {
            await runInTenantScope(
              { orgId: tenant.id, workspaceId: workspace.id },
              () =>
                withTenantDb(async (tx) => {
                  const [assistantMsg] = await tx
                    .insert(schema.messages)
                    .values({
                      orgId: tenant.id,
                      workspaceId: workspace.id,
                      conversationId,
                      parentMessageId: parentMessageId ?? undefined,
                      role: "assistant",
                      content: assistantText,
                      // Persist the full ordered chain (reasoning → tools →
                      // text) so a refresh re-renders the timeline, not just the
                      // final prose. The plain `content` column keeps the text
                      // for history/model context.
                      contentBlocks: persistedBlocks,
                      isActiveInBranch: true,
                      metadata: { status: "complete" },
                      createdByUserId: session.user.id,
                      updatedByUserId: session.user.id,
                    })
                    .returning({ id: schema.messages.id });
                  if (assistantMsg) {
                    // Advance the conversation's active leaf to the assistant
                    // reply so the next turn threads from here.
                    await tx
                      .update(schema.conversations)
                      .set({ activeLeafMessageId: assistantMsg.id, updatedAt: new Date() })
                      .where(eq(schema.conversations.id, conversationId));
                  }
                }),
            );
          } catch (persistErr) {
            logger.error({ err: persistErr }, "[chat/stream] failed to persist assistant reply");
          }
        }

        // Auto-title new conversations using the fast model (fire-and-forget).
        // Only fires on the first turn; the isNull predicate in
        // autoTitleConversation makes concurrent calls idempotent.
        if (newConversation && conversationId) {
          void autoTitleConversation({
            conversationId,
            firstUserMessage: content,
            orgId: tenant.id,
            workspaceId: workspace.id,
            requestId,
          });
        }
      } catch (err) {
        // Log server-side first: this catch covers model-framework crashes,
        // materializeTools failures, IAM kernel panics, and any unexpected
        // throw in the turn. Without this, agent-turn failures are invisible
        // in server logs and ClickHouse — an operator can't tell a transient
        // rate-limit from a recurring code defect.
        logger.error({ err, requestId }, "[chat/stream] turn error");
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
