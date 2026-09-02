import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import {
  selectModel,
  supportsReasoning,
  supportsVision,
  supportsVideoInput,
  modelIdOf,
  loadEffectiveModelDefaults,
  resolvePrompt,
  chatSystemPrompt,
  codeModeSystemPrompt,
  loadWorkspacePromptConfig,
  tool,
  type ToolSet,
  type ModelMessage,
  type SkillIndexEntry,
} from "@oxagen/ai";
import {
  materializeTools,
  createApprovalRequest,
  waitForApproval,
} from "@oxagen/agent";
import {
  createPlatformAgentAi,
  ModalSandboxWorkspace,
  isSandboxAvailable,
} from "@oxagen/agent/adapters";
import { resolveGitHubToken } from "@oxagen/handlers/lib/github-token";
import { parseMentions } from "@oxagen/ai/mentions";
import { executeTurn, DEFAULT_MAX_AGENT_STEPS } from "@oxagen/agent-runner";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke, isCodeAgentType } from "@oxagen/oxagen";
import { CHAT_CONTENT_MAX_CHARS } from "@oxagen/oxagen/contracts/chat.message.send";
import { formFill } from "@oxagen/oxagen/contracts/form.fill";
import { fieldDescriptorSchema } from "@oxagen/oxagen/contracts/form.fill";
import { randomUUID } from "node:crypto";
import type {
  StreamEvent,
  AssistantContentBlock,
  MemoryRecallHit,
  MessageReceipt,
} from "@/components/chat/stream-event-types";
import { autoTitleConversation } from "./auto-title";
import {
  parseStoredCodeBinding,
  resolveCodeBinding,
  toStoredCodeBinding,
} from "./code-binding";
import {
  buildRecentTurns,
  extractToolActivity,
  generateTurnSuggestions,
  type TurnSuggestion,
} from "./suggest-prompts";
import { streamMediaGeneration } from "./media-generation";
import { inferMediaIntent } from "./infer-media-intent";
import { createTurnTranslator, emitUsageEvent } from "./translate-stream";
import { formatStreamError } from "./stream-parts";
import {
  buildHistoryMessages,
  collectRecentAttachmentPublicIds,
} from "./history";
import {
  resolveAttachmentImages,
  resolveAttachmentMediaDetailed,
} from "./attachments";
import { decideAttachmentRouting } from "./attachment-routing";
import {
  recallWorkspaceMemoryDetailed,
  resolveGroundingCitations,
} from "./recall-context";
import { buildPageContextMessage } from "./page-context";
import { evaluateTurnCreditGate } from "./credit-gate";
import {
  applyAgentBinding,
  type AgentBindingDefinition,
} from "./apply-agent-binding";
// Per-turn dollar budget (OXA — turn-budget). The gate itself (policy shape,
// modes, the pure evaluator, createTurnBudgetGuard) lives in @oxagen/billing —
// this route only resolves the effective policy and wires the three hooks to
// its own SSE/approval machinery.
import {
  createTurnBudgetGuard,
  formatBudgetUsd,
  resolveEffectiveTurnBudget,
  TURN_BUDGET_OFF,
  requestTurnBudgetSchema,
  resolveTurnBudgetPolicy,
  turnBudgetPolicyFromSaved,
  governedBudgetFromRead,
  type SavedWorkspaceGovernance,
} from "@oxagen/billing";
import { budgetPolicyReadHandler } from "@oxagen/handlers/budget.policy.read";
import {
  isCurrentUserTurnAtHead,
  CHAT_MAX_RETRIES,
  CHAT_MAX_OVERFLOW_RETRIES,
} from "./history-dedup";

// Side-effect imports: bind every handler into the shared kernel BEFORE
// materializeTools runs so invoke() can resolve both agent.* and all
// non-agent.* agent-surface capabilities (form.fill, svg.generate, etc.).
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

const BodySchema = z.object({
  // Bound the message body — the shared per-message ingress cap (see
  // CHAT_CONTENT_MAX_CHARS in the chat.message.send contract) so every chat
  // surface rejects oversized prompts identically.
  content: z.string().min(1).max(CHAT_CONTENT_MAX_CHARS),
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
  // Session-level skill pinning: skill slugs to pre-load into the system prompt.
  // Pinned skills are injected directly (no tool call needed), so the model
  // applies them from the first turn. Capped at 5 to bound prompt bloat.
  skills: z.array(z.string().min(1).max(64)).max(5).optional().default([]),
  // Attachments for this turn — IDS ONLY (never base64/bytes through this
  // 32 KiB body). Each publicId is re-resolved server-side below (ownership +
  // status='ready' + kind ∈ {image,video} allowlist) before its bytes are
  // fetched from private blob storage. Images become multimodal image parts;
  // videos are routed (video-capable model → file part; vision-only → the
  // client-extracted keyframes; neither → 422 — see attachment-routing.ts).
  // `keyframeForVideo` marks an image that is a client-extracted keyframe of
  // the referenced video attachment, so keyframes are dropped when the video
  // rides as a real file part. Capped at 16 to bound request size + per-turn
  // vision cost (a single video can contribute up to 6 keyframe images).
  attachments: z
    .array(
      z.object({
        publicId: z.string().min(1),
        keyframeForVideo: z.string().min(1).nullable().optional(),
      }),
    )
    .max(16)
    .default([]),
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
  // Per-turn dollar budget override (OXA — turn-budget). `null`/omitted means
  // "no override for this turn" — the route falls back to the user's saved
  // default (budget.policy.read). An explicit object always wins, including
  // an explicit `{ enabled: false }` that turns OFF a saved default for one
  // turn. Schema (incl. the "positive limitUsd when enabled" refinement)
  // lives in @oxagen/billing (turn-budget-policy) so every chat surface
  // validates and resolves budgets identically.
  budget: requestTurnBudgetSchema.nullable().default(null),
  // Code mode (forced repo + environment selection in the composer). When
  // present, the turn runs the coding engine against a durable sandbox with the
  // repo cloned and the environment's vault secrets injected, using the
  // code-mode system prompt and the full workspace toolset (read_file/write_file/
  // edit_file/list_dir/glob/grep/bash). `null`/omitted ⇒ normal chat.
  // owner/name come from the client's repo picker (the workspace GitHub token
  // gates access, exactly like repo.branch.create); the sandbox only activates
  // when a driver is configured (SANDBOX_ENABLED) — otherwise the turn still uses
  // the code-mode prompt but advertises no filesystem tools and says so.
  code: z
    .object({
      connectionId: z.string().min(1),
      owner: z.string().min(1).max(256),
      name: z.string().min(1).max(256),
      defaultBranch: z.string().min(1).max(256).nullable().default(null),
      environmentId: z.string().min(1),
      // Human label for the environment so the agent context shows the name,
      // not the opaque env_… id. Optional/nullable for older clients.
      environmentName: z.string().max(256).nullable().default(null),
      sandboxSessionId: z.string().min(1).nullable().default(null),
    })
    .nullable()
    .default(null),
  // Selected/bound agent (OXA app-agent-selector + Workbench chat↔agent binding) —
  // the publicId (`agt_…`) of the agent chosen in the composer (or threaded
  // from the Ask page's `?agent=<publicId>` URL param), or null/omitted for the
  // default (generic chat) agent. When present, this turn is BOUND to that
  // agent: its instructions ride the system prompt, its equipped skills + MCP
  // servers extend the toolset, and a code agent (agentType === "code") forces
  // code mode ON. A code agent is also the AUTHORITATIVE gate for code mode:
  // only a code agent may bind the sandbox + code tools, so a `code` payload
  // sent alongside a non-code agent is ignored server-side (see the code-mode
  // branch below). Absent `agentId`, every downstream value is untouched
  // (byte-for-byte the pre-binding behavior).
  agentId: z.string().min(1).max(64).nullable().default(null),
  // Pinned chat context (org/repo + environment) the user stuck to this
  // conversation via the composer's context bar. Unlike `code` this is
  // LIGHTWEIGHT — no sandbox — it just tells the agent which repository /
  // environment the user means so it doesn't have to ask. Rides as a per-turn
  // user context message (ADR-021 §2), never the cached system prompt. The
  // composer only sends it when pinned AND not in code mode (code already
  // conveys the same target), so the two never double up.
  pinnedContext: z
    .object({
      repo: z
        .object({
          connectionId: z.string().min(1),
          owner: z.string().min(1).max(256),
          name: z.string().min(1).max(256),
          defaultBranch: z.string().min(1).max(256).nullable().default(null),
        })
        .nullable()
        .default(null),
      environment: z
        .object({
          id: z.string().min(1),
          name: z.string().min(1).max(256),
        })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
});

// Maximum number of prior messages to include in the context window. Keeps
// prompt size bounded while preserving enough history for coherent multi-turn
// conversations. The newest HISTORY_LIMIT messages are taken (DESC + LIMIT,
// then reversed so the model sees them chronologically oldest→newest).
const HISTORY_LIMIT = 50;

// Text-tier fallback order tried by the attachment vision guard when the
// picker's selected model can't take image input. Balanced first (the
// platform default), then fast, then precise — every default OXAGEN_LLM_*
// tier is normally vision-capable, so this only matters for an
// unusually-configured workspace.
const ATTACHMENT_VISION_TIER_FALLBACK = [
  "balanced",
  "fast",
  "precise",
] as const;

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
// This route is the SINGLE LLM caller per turn. The server action
// (`sendMessageAction`) only handles Postgres persistence. History is loaded
// here directly from the messages table, scoped to the resolved workspace and
// ordered deterministically by createdAt.
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
    skills: pinnedSkillSlugs,
    agentId,
    pageContext,
    attachments,
    budget: requestBudget,
    code: codeModeRaw,
    pinnedContext,
  } = parsed.data;

  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    tenant = await resolveOrg(orgSlug);
    // Membership gate: any authenticated user can submit a request to any org
    // slug — assert they are actually a member before we touch any org-scoped
    // data (IDOR guard). The workspace lookup and the membership assertion both
    // depend only on tenant.id and have no side effects, so run them
    // concurrently. Semantics are unchanged: a non-member's Promise.all rejects
    // (the speculative workspace row is discarded) and both failure modes return
    // the same generic 404 — org-scoped DATA access still happens strictly after
    // this block, gated on a resolved membership.
    const [, resolvedWorkspace] = await Promise.all([
      assertOrgMember(tenant.id, session.user.id),
      resolveWorkspace(tenant.id, workspaceSlug),
    ]);
    workspace = resolvedWorkspace;
  } catch {
    return NextResponse.json(
      { error: "Org or workspace not found" },
      { status: 404 },
    );
  }

  // ── Pre-turn credit admission gate ───────────────────────────────────────────
  // Run the SAME admission gate (assertCanStartTurn) that already fires on every
  // scoped contract.invoke() tool call, BEFORE the top-level model turn begins —
  // the model stream reaches `streamAgentReply` as a direct @oxagen/ai
  // call, not an invoke(), so without this a no-tool-call turn skipped the
  // balance check and a suspended / zero-balance org got a full model call for
  // free. Blocks ONLY on the affirmative InsufficientCredits / BillingSuspended
  // outcomes (every org has a $5 Free signup grant ⇒ zero balance = depleted,
  // never billing-absent) and fails OPEN on any non-billing error, so a metering
  // hiccup never blocks a paying customer (credit-gate.ts). Runs inside the
  // tenant scope the underlying withTenantDb reads require.
  const creditGate = await runInTenantScope(
    { orgId: tenant.id, workspaceId: workspace.id },
    () => evaluateTurnCreditGate(tenant.id),
  );
  if (!creditGate.ok) {
    return NextResponse.json(
      { error: { code: creditGate.code, message: creditGate.message } },
      { status: 402 },
    );
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

  // `let` — the attachment vision guard below may swap this for a
  // vision-capable tier model when the picker's selection can't take image
  // input.
  let turnModel = selectModel({
    ...(resolvedModel
      ? { model: resolvedModel }
      : resolvedTier
        ? { tier: resolvedTier }
        : {}),
  });

  // Reasoning effort is only valid on reasoning-capable models. Re-check
  // server-side against the catalog (keyed by the resolved gateway model id) so
  // a stray `effort` for a non-reasoning model is dropped rather than forwarded.
  const turnEffort =
    effort && supportsReasoning(modelIdOf(turnModel)) ? effort : undefined;

  // ── Media-generation branch ───────────────────────────────────────────────
  // This turn generates an image/video instead of running the text agent when
  // media intent is present. There is no manual "Generate image / video"
  // toggle in the app — an explicit `generate` (from API clients) still wins,
  // but otherwise we INFER intent from the prompt ("make me a logo", "create a
  // short video of waves"). inferMediaIntent is conservative and never fires on
  // attachment or code-mode turns, so ordinary chat is unaffected. Resolve the
  // media model (explicit per-turn → effective workspace/user default → tier
  // default inside streamMediaGeneration).
  const effectiveGenerate =
    generate ??
    inferMediaIntent(content, {
      hasAttachments: attachments.length > 0,
      isCodeMode: codeModeRaw != null,
    });
  if (effectiveGenerate) {
    let resolvedMediaModel = mediaModel;
    if (!resolvedMediaModel) {
      try {
        const mediaDefaults = await loadEffectiveModelDefaults({
          userId: session.user.id,
          workspaceId: workspace.id,
        });
        resolvedMediaModel =
          effectiveGenerate === "image"
            ? (mediaDefaults.image.model ?? null)
            : (mediaDefaults.video.model ?? null);
      } catch {
        // Fall through to tier default inside streamMediaGeneration.
      }
    }
    return streamMediaGeneration({
      kind: effectiveGenerate,
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

  // ── Attachments (Phase 1 images + Phase 2 video) ──────────────────────────
  // Resolve the current turn's attachment publicIds org-scoped (ownership +
  // status='ready' + kind ∈ {image,video} allowlist enforced inside
  // resolveAttachmentMedia) and fetch their bytes server-side. An id that
  // doesn't resolve is a hard 422 — the user explicitly attached it, so
  // silently dropping it would mean the model answers about media it never
  // saw. Never a base64 round-trip through the client: refs-by-publicId in,
  // raw bytes fetched straight from private blob storage.
  //
  // decideAttachmentRouting then picks, purely, how each kind reaches the
  // model: a video goes as a real file part when the model (or an upgrade
  // candidate) is video-capable, else as its client-extracted keyframe images,
  // else a hard 422. Images always ride the image path (with a vision upgrade
  // of their own if needed).
  let imageAttachments: Array<{ data: Buffer; mediaType: string }> = [];
  let videoAttachments: Array<{ data: Buffer; mediaType: string }> = [];
  if (attachments.length > 0) {
    const publicIds = attachments.map((a) => a.publicId);
    const { resolved, notFound, fetchFailed } =
      await resolveAttachmentMediaDetailed(publicIds, {
        orgId: tenant.id,
        workspaceId: workspace.id,
      });
    // A genuinely missing row is user-fixable (unknown/foreign/not-ready/
    // deleted) → 422 with the "re-attach" guidance. A row that EXISTS but whose
    // bytes momentarily failed to fetch is NOT the user's fault → retryable 502.
    // Splitting the two ends the historical P0 where every attachment failure
    // (including transient storage blips) was blamed on the user.
    if (fetchFailed.length > 0) {
      logger.error(
        { orgId: tenant.id, workspaceId: workspace.id, fetchFailed, notFound },
        "[chat/stream] attachment bytes failed to fetch from storage",
      );
      return NextResponse.json(
        {
          error:
            "We found your attachment but couldn't load it from storage just now. This is usually temporary — please try sending again in a moment.",
        },
        { status: 502 },
      );
    }
    if (notFound.length > 0) {
      logger.warn(
        { orgId: tenant.id, workspaceId: workspace.id, notFound },
        "[chat/stream] attachment publicIds did not resolve for this tenant",
      );
      return NextResponse.json(
        {
          error:
            "One or more attachments could not be found, belong to another workspace, or are not ready yet. Please remove and re-attach the file, then try again.",
        },
        { status: 422 },
      );
    }

    // Partition into image vs. video refs by the AUTHORITATIVE stored kind
    // (never the client's word). `keyframeForVideo` is a client grouping hint,
    // only affecting which images are dropped when a video rides as a file part.
    const imageRefs = attachments
      .filter((a) => resolved.get(a.publicId)!.kind === "image")
      .map((a) => ({
        publicId: a.publicId,
        keyframeForVideo: a.keyframeForVideo,
      }));
    const videoRefs = attachments
      .filter((a) => resolved.get(a.publicId)!.kind === "video")
      .map((a) => ({ publicId: a.publicId }));

    const upgradeCandidates = ATTACHMENT_VISION_TIER_FALLBACK.map(
      (fallbackTier) => modelIdOf(selectModel({ tier: fallbackTier })),
    );
    const decision = decideAttachmentRouting({
      model: modelIdOf(turnModel),
      images: imageRefs,
      videos: videoRefs,
      supportsVision,
      supportsVideoInput,
      upgradeCandidates,
    });
    if (decision.kind === "error") {
      return NextResponse.json({ error: decision.message }, { status: 422 });
    }

    if (decision.model !== modelIdOf(turnModel)) {
      logger.info(
        {
          orgId: tenant.id,
          workspaceId: workspace.id,
          requestedModel: modelIdOf(turnModel),
          upgradedModel: decision.model,
          hasVideo: videoRefs.length > 0,
        },
        "[chat/stream] auto-upgraded model for multimodal attachments",
      );
      turnModel = selectModel({ model: decision.model });
    }

    imageAttachments = decision.imagePublicIds.map((id) => {
      const m = resolved.get(id)!;
      return { data: m.data, mediaType: m.mediaType };
    });
    videoAttachments = decision.videoPublicIds.map((id) => {
      const m = resolved.get(id)!;
      return { data: m.data, mediaType: m.mediaType };
    });
  }

  // Load conversation history from Postgres so the model has context for every
  // prior turn — without this the model has no memory of earlier messages.
  let historyMessages: ModelMessage[] = [];
  // True when the trailing (newest) history row IS this turn's user message —
  // detected by message id, not text. sendMessageAction persists the user turn
  // concurrently, so it may already be the newest row; the engine appends the
  // instruction itself, so we must drop that row or the model sees the prompt
  // twice. Id comparison is robust to equal text and equal createdAt (the
  // failure mode of the old text-only dedup).
  let currentAlreadyInHistory = false;
  if (conversationId) {
    // Fetch the most-recent HISTORY_LIMIT rows (DESC + LIMIT), then reverse in
    // JS so they end up chronological (oldest→newest). ASC + LIMIT would return
    // the OLDEST N rows and drop all recent context.
    //
    // Tenant isolation: wrapped in runInTenantScope + withTenantDb so the
    // Postgres RLS policies enforce isolation at the DB layer. The
    // eq(orgId)/eq(workspaceId) predicates are belt-and-suspenders planner hints.
    const rows = await runInTenantScope(
      { orgId: tenant.id, workspaceId: workspace.id },
      () =>
        withTenantDb((tx) =>
          tx
            .select({
              // id: used to dedup this turn's user message from history by id
              // (see currentAlreadyInHistory) — robust to equal text/createdAt.
              id: schema.messages.id,
              role: schema.messages.role,
              content: schema.messages.content,
              // content_blocks carries the assistant turn's real output (tool
              // calls, generated files, code runs). Without it, tool-only turns
              // (empty text) were dropped from history and the model re-ran every
              // prior tool call on each new turn — see buildHistoryMessages.
              contentBlocks: schema.messages.contentBlocks,
              // metadata.attachments carries user-turn attachment refs — bounded
              // replay (last 2 user turns) is resolved to real image parts below.
              metadata: schema.messages.metadata,
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

    const historyRows = rows.map((r) => ({
      role: r.role,
      content: r.content,
      contentBlocks: r.contentBlocks as AssistantContentBlock[] | null,
      metadata: r.metadata,
    }));

    // Dedup this turn's user message by id (see isCurrentUserTurnAtHead).
    currentAlreadyInHistory = isCurrentUserTurnAtHead(rows, parentMessageId);

    // Bounded image replay: only the most recent RECENT_IMAGE_TURN_LIMIT user
    // turns' attachments are re-fetched as real image parts; older turns fall
    // back to a `[attached image: <name>]` text placeholder inside
    // buildHistoryMessages. Bounds vision-token growth over a long
    // conversation instead of re-sending every past image every turn.
    const recentImagePublicIds = collectRecentAttachmentPublicIds(historyRows);
    const resolvedHistoryImages =
      recentImagePublicIds.length > 0
        ? await resolveAttachmentImages(recentImagePublicIds, {
            orgId: tenant.id,
            workspaceId: workspace.id,
          })
        : new Map<string, { data: Buffer; mediaType: string }>();

    // Reconstruct history so assistant turns carry a summary of the actions they
    // ALREADY completed (marked DONE), so the model never re-fires finished tool
    // calls. Rows arrive newest-first; buildHistoryMessages reverses to
    // chronological order.
    historyMessages = buildHistoryMessages(historyRows, resolvedHistoryImages);
  }

  // The engine appends `instruction` (this turn's content) itself, so the
  // history it receives must EXCLUDE the current user message. When it is
  // already the trailing history row (detected by id above), drop it so the
  // model never sees the current turn twice. Rows are chronological here
  // (buildHistoryMessages reversed them), so the newest is the last element.
  const historyForEngine: ModelMessage[] = currentAlreadyInHistory
    ? historyMessages.slice(0, -1)
    : historyMessages;

  const requestId = randomUUID();
  // Wall-clock anchor for the per-message receipt's duration (chat_ux_v2).
  const turnStartedAtMs = Date.now();

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
      // Enqueue-safe emit: the engine step loop calls translator.onPart → emit
      // synchronously inside the stream loop. If the client disconnected the
      // controller is closed and enqueue THROWS; that throw would propagate into
      // the engine step's try/catch and be misclassified as a model/stream
      // error (triggering a retry). Swallow it and latch `closed` — the
      // request.signal abort is what actually stops the loop.
      let closed = false;
      function emit(event: StreamEvent): void {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      }

      // The stateful SSE translator. Declared here (not inside the try) so the
      // catch can flush + persist a PARTIAL turn if the engine throws mid-stream
      // — today an error PART did not throw, so partial output still persisted;
      // the engine throws instead, so we reproduce that behaviour explicitly.
      let translator: ReturnType<typeof createTurnTranslator> | null = null;

      // Code mode: a durable sandbox workspace bound to the selected repo for
      // this turn. Declared here so the finally can always tear the session
      // down. Null unless the turn is a code-mode turn with a configured driver.
      let codeWorkspace: ModalSandboxWorkspace | null = null;

      // Persist the assistant reply so it survives a refresh and is included in
      // the next turn's history. Best-effort: a DB failure here must
      // NOT corrupt the SSE response the client already consumed, and must not
      // escape into the outer catch (it wraps its own try/catch).
      async function persistAssistantTurn(
        assistantText: string,
        persistedBlocks: AssistantContentBlock[],
        receipt?: MessageReceipt,
      ): Promise<void> {
        if (
          !conversationId ||
          (assistantText.length === 0 && persistedBlocks.length === 0)
        ) {
          return;
        }
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
                    // Persist the full ordered chain (reasoning → tools → text)
                    // so a refresh re-renders the timeline, not just the final
                    // prose. The plain `content` column keeps the text for
                    // history/model context.
                    contentBlocks: persistedBlocks,
                    // The receipt (model · effort · cost · duration · tokens)
                    // rides in metadata so history renders the same numbers
                    // the live usage event carried. Absent on partial turns.
                    metadata: receipt
                      ? { status: "complete", receipt }
                      : { status: "complete" },
                    createdByUserId: session.user.id,
                    updatedByUserId: session.user.id,
                  })
                  .returning({ id: schema.messages.id });
                if (assistantMsg) {
                  // Advance the conversation's active leaf to the assistant
                  // reply so the next turn threads from here.
                  await tx
                    .update(schema.conversations)
                    .set({
                      activeLeafMessageId: assistantMsg.id,
                      updatedAt: new Date(),
                    })
                    .where(eq(schema.conversations.id, conversationId));
                }
              }),
          );
        } catch (persistErr) {
          logger.error(
            { err: persistErr },
            "[chat/stream] failed to persist assistant reply",
          );
          // The turn itself succeeded and the client already consumed the reply;
          // only history persistence failed. Surface a NON-fatal warning so the
          // user knows this turn may be missing after a refresh, instead of
          // silently swallowing it. Never rethrow — a persist failure must not
          // corrupt the SSE response.
          emit({
            type: "warning",
            message:
              "Your reply streamed but could not be saved to history — it may be missing if you refresh.",
            code: "assistant_persist_failed",
          });
        }
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
          // The same per-turn key handed to the metered AI port below
          // (createPlatformAgentAi(capCtx, capCtx.messageId, "app")), so
          // skill_loads and token_usage join for this turn (#2597).
          executionStepId: parentMessageId ?? requestId,
          clientIp,
        };

        // ── Conversation code binding (locked coding target) ────────────────
        // The repo + environment + agent chosen on a conversation's FIRST
        // code-mode turn is persisted on the conversation row and locked for
        // its lifetime (claimed in the code-mode block below). Resolve this
        // turn against the stored binding FIRST so a stale client or a
        // mid-conversation picker change can never retarget the sandbox —
        // matching the CLI, where the repo is the launch cwd, pinned for the
        // whole session. Fail-open: a read failure degrades to unbound
        // (request values stand), never a dead turn.
        let storedCodeBinding: ReturnType<typeof parseStoredCodeBinding> = null;
        if (conversationId) {
          try {
            const [conversationRow] = await runInTenantScope(
              { orgId: tenant.id, workspaceId: workspace.id },
              () =>
                withTenantDb((tx) =>
                  tx
                    .select({ codeBinding: schema.conversations.codeBinding })
                    .from(schema.conversations)
                    .where(
                      and(
                        eq(schema.conversations.id, conversationId),
                        eq(schema.conversations.orgId, tenant.id),
                        eq(schema.conversations.workspaceId, workspace.id),
                      ),
                    )
                    .limit(1),
                ),
            );
            storedCodeBinding = parseStoredCodeBinding(
              conversationRow?.codeBinding,
            );
          } catch (err) {
            logger.warn(
              { err: String(err), conversationId, requestId },
              "[chat/stream] code-binding read failed — running turn unbound",
            );
          }
        }
        const bindingResolution = resolveCodeBinding({
          stored: storedCodeBinding,
          requestedAgentId: agentId,
          requestedCode: codeModeRaw,
        });
        const effectiveAgentId = bindingResolution.agentId;
        for (const message of bindingResolution.warnings) {
          emit({ type: "warning", message, code: "code_binding_locked" });
        }

        // ── Optional agent binding (launch a published agent into this session) ─
        // When the request carries an `agentId`, load that agent's definition ONCE
        // and merge its config into THIS turn BEFORE tools + prompt are assembled:
        //   • instructions → appended to the system-prompt baseline (below),
        //   • skill agentTools → unioned into the pinned-skill slugs,
        //   • mcp_server agentTools → unioned into the MCP server allowlist,
        //   • agentType "code"/"coding" → the ONLY thing that can put a turn
        //     in coding flow: `useCodeModePrompt` and the authoritative
        //     `codeMode` gate below both derive from `agentIsCode`. A `code`
        //     payload without a code agent is dropped regardless of what the
        //     client sent.
        // Absent an agent, every effective value is exactly the request value.
        //
        // FAIL-OPEN: a failed/denied agent.definition.get must NEVER break the
        // turn — log and fall through to the normal (unbound) behavior, exactly
        // like the budget-governance read below. Runs in a tenant scope because
        // the handler reads through withTenantDb. { surface: "agent" } — the
        // contract's `surfaces` list is ["api","mcp","agent"], not "app".
        let boundInstructions = "";
        let effectiveSkillSlugs = pinnedSkillSlugs;
        let effectiveServerIds = activeServerIds;
        let agentIsCode = false;
        // `useCodeModePrompt` drives the code-mode SYSTEM PROMPT; the sandbox
        // is still only bound when `codeMode` (the authoritative value
        // computed below) carries a repo/env. Both derive from the AGENT
        // DEFINITION: without a code agent there is no coding flow, so the
        // prompt starts false and only `binding.codeMode` (= is-code-agent)
        // can raise it. A coding agent with no repo degrades to the code-mode
        // prompt with no filesystem tools (see the code-mode block below).
        let useCodeModePrompt = false;
        if (effectiveAgentId) {
          try {
            const def = await runInTenantScope(
              { orgId: tenant.id, workspaceId: workspace.id },
              () =>
                invoke("get_agent_def", { agentId: effectiveAgentId }, capCtx, {
                  surface: "agent",
                }),
            );
            agentIsCode = isCodeAgentType(
              (def as AgentBindingDefinition).agentType,
            );
            const binding = applyAgentBinding({
              def: def as AgentBindingDefinition,
              skills: pinnedSkillSlugs,
              serverAllowlist: activeServerIds,
            });
            boundInstructions = binding.instructions;
            effectiveSkillSlugs = binding.skills;
            effectiveServerIds = binding.serverAllowlist;
            useCodeModePrompt = binding.codeMode;
          } catch (err) {
            logger.warn(
              { err, agentId: effectiveAgentId, requestId },
              "[chat/stream] agent binding failed — running unbound turn",
            );
          }
        }

        // ── Authoritative code-mode gate (agent-definition–driven) ──────────
        // Coding flow exists ONLY when the bound agent's definition marks it
        // a code agent. A `code` payload without one is dropped, and a stored
        // binding whose agent no longer resolves as code is likewise inert.
        // Hoisted ABOVE materializeTools so the capability tool list can
        // exclude the mutation paths that overlap the engine's repo-bound
        // workspace toolset.
        const codeMode = agentIsCode ? bindingResolution.code : null;
        if (!agentIsCode && bindingResolution.code) {
          emit({
            type: "warning",
            message:
              "Repository tools are only available to coding agents — this turn runs without them.",
            code: "code_mode_requires_code_agent",
          });
        }

        const [
          { tools: agentTools, nameMap: toolNameMap, mutatingToolNames },
          promptConfig,
          skillIndex,
          pinnedSkillBodies,
          recalledMemory,
          turnBudgetPolicy,
          workspaceBudgetGovernance,
        ] = await runInTenantScope(
          { orgId: tenant.id, workspaceId: workspace.id },
          () =>
            Promise.all([
              materializeTools(capCtx, {
                // Code mode binds the engine's repo-bound workspace toolset
                // (read_file/edit_file/bash …) — the ONLY sanctioned way for
                // the model to touch the repository. Exclude the capability
                // tools that overlap it: execute_code runs in a separate
                // ephemeral sandbox (the model would "verify" its edits in a
                // box that doesn't contain them) and edit_repo_file spawns a
                // nested clone-edit-PR loop. (The durable sandbox session
                // family is Workbench-only and never materialized — see
                // WORKBENCH_ONLY_SANDBOX_CAPS in materialize-tools.ts.)
                excludeCapabilities: codeMode
                  ? new Set(["execute_code", "edit_repo_file"])
                  : undefined,
                // Effective allowlist = request activeServerIds ∪ any mcp_server
                // refs from the bound agent (unchanged when no agent is bound).
                serverAllowlist:
                  effectiveServerIds.length > 0
                    ? new Set(effectiveServerIds)
                    : undefined,
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
              }),
              loadWorkspacePromptConfig(workspace.id).catch(() => ({})),
              // Skill index for progressive disclosure: fetch enabled skills
              // so the prompt shows available slugs (~15 tokens each).
              withTenantDb((tx) =>
                tx
                  .select({
                    slug: schema.skills.slug,
                    description: schema.skills.description,
                  })
                  .from(schema.skills)
                  .where(
                    and(
                      eq(schema.skills.orgId, tenant.id),
                      eq(schema.skills.workspaceId, workspace.id),
                      eq(schema.skills.enabled, true),
                      isNull(schema.skills.deletedAt),
                    ),
                  ),
              )
                .then((rows): SkillIndexEntry[] =>
                  rows.map((r) => ({
                    slug: r.slug,
                    description: r.description ?? "",
                  })),
                )
                .catch((): SkillIndexEntry[] => []),
              // Session-level pinned skills: resolve bodies for requested slugs.
              // Only loads enabled, non-deleted skills the user explicitly pinned
              // (plus any skill refs contributed by the bound agent — union
              // computed above; identical to pinnedSkillSlugs when unbound).
              effectiveSkillSlugs.length > 0
                ? withTenantDb((tx) =>
                    tx
                      .select({
                        slug: schema.skills.slug,
                        body: schema.skillVersions.body,
                      })
                      .from(schema.skills)
                      .innerJoin(
                        schema.skillVersions,
                        eq(
                          schema.skillVersions.id,
                          schema.skills.activeVersionId,
                        ),
                      )
                      .where(
                        and(
                          eq(schema.skills.orgId, tenant.id),
                          eq(schema.skills.workspaceId, workspace.id),
                          eq(schema.skills.enabled, true),
                          isNull(schema.skills.deletedAt),
                          sql`${schema.skills.slug} = ANY(${effectiveSkillSlugs})`,
                        ),
                      ),
                  )
                    .then(
                      (rows): Array<{ slug: string; body: string }> =>
                        rows.map((r) => ({ slug: r.slug, body: r.body })),
                    )
                    .catch((): Array<{ slug: string; body: string }> => [])
                : Promise.resolve([] as Array<{ slug: string; body: string }>),
              // Deterministic memory recall for this turn: query workspace memory
              // with the latest user text so relevant prior lessons are injected
              // BEFORE the model runs — the agent never re-discovers something it
              // already remembered. executionRef ties recalled memories to this
              // turn as CONSIDERED citations (the promotion/self-improvement
              // flywheel). Best-effort + time-boxed inside the helper: a slow or
              // down Neo4j yields null and the turn proceeds untouched.
              recallWorkspaceMemoryDetailed({
                query: content,
                executionRef: capCtx.messageId,
                ctx: capCtx,
              }),
              // Per-turn dollar budget (OXA — turn-budget): an explicit
              // per-turn `requestBudget` always wins (no DB round-trip
              // needed); omitting it falls back to the user's saved default
              // via budget.policy.read (direct handler call, same pattern as
              // userPreferencesReadHandler in conversation-page.tsx — budget
              // policy is user-scoped and needs no IAM bootstrap). A failed
              // read degrades to TURN_BUDGET_OFF so a broken preferences row
              // never blocks a turn from running.
              requestBudget
                ? Promise.resolve(
                    resolveTurnBudgetPolicy(requestBudget, TURN_BUDGET_OFF),
                  )
                : budgetPolicyReadHandler({}, capCtx)
                    .then(turnBudgetPolicyFromSaved)
                    .catch(() => TURN_BUDGET_OFF),
              // Workspace-level budget governance: a workspace
              // Owner/Admin may impose a governed budget (a soft "default"
              // that seeds a member who hasn't opted in, or a hard "ceiling"
              // that clamps every member's effective policy — see
              // resolveEffectiveTurnBudget in @oxagen/billing). Read via
              // invoke() (not a raw handler import like budget.policy.read
              // above) because this is Owner/Admin-managed governance state,
              // not a user preference row, so it goes through the same
              // metering/IAM chokepoint every other capability call does.
              // { surface: "agent" } because the contract's `surfaces` list
              // is ["api","mcp","agent"] and does not include "app".
              //
              // FAIL-OPEN: any error — an unregistered handler, a down DB, a
              // denied IAM check — resolves to `null` governance, which makes
              // resolveEffectiveTurnBudget's merge below a documented no-op
              // (the member's own policy applies unchanged). A broken
              // governance row must never block a turn from running, exactly
              // like the TURN_BUDGET_OFF fallback above.
              invoke("get_budget_policy", {}, capCtx, { surface: "agent" })
                .then((raw) =>
                  governedBudgetFromRead(raw as SavedWorkspaceGovernance),
                )
                // FAIL-OPEN (see comment above) but never SILENT: a swallowed
                // governance-read failure (down DB, denied IAM, unregistered
                // handler) must be observable, or a mis-applied budget is
                // undiagnosable in the field.
                .catch((err) => {
                  logger.warn(
                    { err: String(err), requestId },
                    "[chat/stream] workspace budget governance read failed — failing open to member policy",
                  );
                  return null;
                }),
            ]),
        );

        // Merge in workspace-level governance on top of the
        // member's own resolved policy. `resolveEffectiveTurnBudget` is the
        // SAME pure merge every surface (CLI/API/app) will share once org-level
        // governance also lands — org governance is a separate follow-up, so
        // `org` is passed `null` here (a no-op in the merge). This is the
        // policy actually handed to the guard below.
        const effectiveTurnBudgetPolicy = resolveEffectiveTurnBudget(
          turnBudgetPolicy,
          null,
          workspaceBudgetGovernance,
        );

        // Resolve the knowledge-graph node each recalled memory is grounded in,
        // CONCURRENTLY with the model turn. These feed the end-of-turn "Grounded
        // in" citation strip only (never the model context), so they never delay
        // the first token. Runs in its own tenant scope because graph.node.get
        // reads through scopedSession, and degrades to [] on any failure so a
        // slow/absent graph never affects the answer.
        const citationsPromise: Promise<MemoryRecallHit[]> =
          recalledMemory.memories.length > 0
            ? runInTenantScope(
                { orgId: tenant.id, workspaceId: workspace.id },
                () =>
                  resolveGroundingCitations({
                    memories: recalledMemory.memories,
                    ctx: capCtx,
                  }),
              ).catch(() => [] as MemoryRecallHit[])
            : Promise.resolve<MemoryRecallHit[]>([]);

        // ── Page context (always) + Page-form-fill tool (request-scoped) ────
        // Page context is VOLATILE per-turn data — the `route` changes on every
        // navigation and a form field's `current` value changes as the user
        // types. It rides as a per-turn USER message (built by
        // buildPageContextMessage), NOT the cached system prompt, so navigation
        // and typing never bust the Anthropic prompt-cache breakpoint on the
        // byte-stable system prefix (docs/adr/ADR-021 §2). This mirrors the
        // code-mode / pinned / references context messages below.
        //
        // When a fillableForm is present, also register a request-scoped
        // `page_form_fill` tool that routes through the kernel.invoke() boundary
        // (IAM + metering).
        const pageContextMessage = buildPageContextMessage(pageContext);
        let pageFormFillTool: ToolSet | undefined;

        if (pageContext?.fillableForm) {
          const { route: pcRoute, entitySummary: pcEntitySummary } =
            pageContext;
          const { fields: pcFields } = pageContext.fillableForm;
          pageFormFillTool = {
            page_form_fill: tool({
              description:
                "Fill or suggest values for the page form the user is currently viewing. " +
                "Call this when the user asks to fill, update, or change the form. " +
                "Pass a clear natural-language instruction describing the desired changes. " +
                "If the request is ambiguous, ask a clarifying question instead.",
              inputSchema: z.object({
                instruction: z
                  .string()
                  .min(1)
                  .describe(
                    "Natural-language instruction describing the desired form changes.",
                  ),
              }),
              execute: async (input: { instruction: string }) => {
                const { instruction } = input;
                const rawResult = await invoke(
                  "fill_form",
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

        // Run the SAME engine the CLI uses — one engine owning retry,
        // compaction and loop detection — instead of a hand-rolled streamText
        // loop. No `workspace` ⇒ no filesystem tools; the
        // materialized capability ToolSet is injected via `extraTools`. The raw
        // AI-SDK parts are forwarded to the stateful SSE translator via
        // `onStreamPart` so the client wire protocol is byte-identical.
        translator = createTurnTranslator({
          requestId,
          toolNameMap,
          orgSlug,
          workspaceSlug,
          emit,
        });

        // Metered AI port (@oxagen/ai). Surface "app" so token usage/credits
        // attribute to the app surface, matching the pre-unification telemetry.
        const ai = createPlatformAgentAi(capCtx, capCtx.messageId, "app");

        const modelId = modelIdOf(turnModel);

        // Per-turn dollar budget (OXA — turn-budget). createTurnBudgetGuard
        // returns undefined when the resolved policy is off, so an unbudgeted
        // turn passes no guard at all (unbounded, byte-identical to before
        // this feature). The three hooks are the ONLY app-specific part of
        // enforcement — the policy shape, the mode ladder, and the pure
        // evaluator all live in @oxagen/billing and must not be reimplemented
        // here. Uses the GOVERNED effective policy (member ⊕ workspace
        // governance, resolved above via resolveEffectiveTurnBudget), not the
        // raw member policy — a workspace ceiling must bind even when the
        // member never configured (or tried to loosen) their own budget.
        const budgetGuard = createTurnBudgetGuard(
          effectiveTurnBudgetPolicy,
          modelId,
          {
            // Live cumulative cost per engine step — powers the client's
            // "≈ $0.31" streaming estimate (chat_ux_v2). Only budgeted turns
            // have a guard, so unbudgeted turns emit no ticks.
            onTick: (costUsd, limitUsd) => {
              emit({ type: "budget-tick", costUsd, limitUsd });
            },
            // grace mode: informational, non-blocking — the turn keeps running
            // past its base limit but inside the grace cushion.
            onWithinGrace: (verdict) => {
              emit({
                type: "budget-notice",
                state: "within_grace",
                costUsd: verdict.costUsd,
                limitUsd: verdict.limitUsd,
                mode: verdict.mode,
              });
            },
            // enforce mode, or a grace cushion exhausted, or a denied/expired
            // prompt-mode pause (below): the turn ends here with
            // `stopReason: "budget"` on the engine result.
            onStop: (verdict) => {
              emit({
                type: "budget-notice",
                state: "stopped",
                costUsd: verdict.costUsd,
                limitUsd: verdict.limitUsd,
                mode: verdict.mode,
              });
            },
            // prompt mode: reuse the EXISTING tool-approval machinery verbatim
            // (packages/agent/src/runtime/approval.ts + the approval-required /
            // approval-resolved SSE events + the client's approval-waiter in
            // use-tool-stream.ts) rather than inventing a second pause protocol.
            // createApprovalRequest/waitForApproval read/write via withTenantDb,
            // which needs an active ALS tenant scope — this hook runs from
            // INSIDE the engine's step loop, OUTSIDE the runInTenantScope that
            // wrapped materializeTools above, so re-enter scope here exactly
            // like the tool-approval execute() closure does.
            onPause: async (verdict) => {
              const costLabel = formatBudgetUsd(verdict.costUsd);
              const limitLabel = formatBudgetUsd(verdict.limitUsd);
              const inputPreview = {
                costUsd: verdict.costUsd,
                limitUsd: verdict.limitUsd,
                message: `Per-turn budget reached: ${costLabel} of ${limitLabel}. Approve to continue for another ${limitLabel}.`,
              };
              const { approvalId } = await runInTenantScope(
                { orgId: tenant.id, workspaceId: workspace.id },
                () =>
                  createApprovalRequest({
                    orgId: tenant.id,
                    workspaceId: workspace.id,
                    messageId: capCtx.messageId,
                    capabilityName: "budget.turn.continue",
                    inputPreview,
                    riskLevel: "low",
                  }),
              );
              const expiresAt = new Date(
                Date.now() + 5 * 60 * 1000,
              ).toISOString();
              emit({
                type: "approval-required",
                approvalId,
                capability: "budget.turn.continue",
                inputPreview,
                riskLevel: "low",
                expiresAt,
              });
              const resolution = await waitForApproval(approvalId);
              return resolution.resolution === "approved";
            },
          },
        );

        // ── Code mode: bind the durable sandbox workspace ─────────────────────
        // When this conversation's coding target is active (`codeMode` — the
        // code agent + effective repo/env resolved through the conversation
        // code binding and the authoritative agent gate above
        // materializeTools), run the coding engine against a sandbox with the
        // repo cloned. The per-turn repo/env context rides as a USER message
        // (ADR-021 §2), never the cached system prompt.
        let codeContextMessage: ModelMessage | undefined;
        if (codeMode) {
          const branch = codeMode.defaultBranch ?? "main";
          const sandboxOn = isSandboxAvailable();
          codeContextMessage = {
            role: "user",
            content:
              "## Code mode context\n" +
              `Repository: ${codeMode.owner}/${codeMode.name} (branch ${branch})\n` +
              // Show the human environment label, not the opaque env_… id.
              `Environment: ${codeMode.environmentName ?? codeMode.environmentId}\n` +
              (sandboxOn
                ? "A sandbox with this repository checked out is bound to this turn — use the file and bash tools to read, edit, build, and test."
                : "No code sandbox is configured on this deployment, so repository tools are unavailable this turn — give read-only guidance and say so."),
          };
          if (sandboxOn) {
            const token = await runInTenantScope(
              { orgId: tenant.id, workspaceId: workspace.id },
              () => resolveGitHubToken(capCtx),
            ).catch((err) => {
              // Best-effort: the sandbox still boots without a token (private
              // repos just fail to clone downstream). Log so a missing token is
              // diagnosable rather than a silent, confusing clone failure.
              logger.warn(
                { err: String(err), requestId },
                "[chat/stream] GitHub token resolution failed — sandbox will run unauthenticated",
              );
              return undefined;
            });
            // First code turn of this conversation: claim the binding
            // atomically (WHERE code_binding IS NULL — a concurrent first
            // turn can never overwrite a winner). Fire-and-forget + fail-open:
            // a claim failure only means the next turn re-attempts; the turn
            // itself proceeds.
            if (conversationId && !storedCodeBinding && effectiveAgentId) {
              const bindingToClaim = toStoredCodeBinding(
                codeMode,
                effectiveAgentId,
              );
              runInTenantScope(
                { orgId: tenant.id, workspaceId: workspace.id },
                () =>
                  withTenantDb((tx) =>
                    tx
                      .update(schema.conversations)
                      .set({ codeBinding: bindingToClaim })
                      .where(
                        and(
                          eq(schema.conversations.id, conversationId),
                          isNull(schema.conversations.codeBinding),
                        ),
                      ),
                  ),
              ).catch((err) => {
                logger.warn(
                  { err: String(err), conversationId, requestId },
                  "[chat/stream] code-binding claim failed — next turn retries",
                );
              });
            }
            codeWorkspace = new ModalSandboxWorkspace({
              ctx: capCtx,
              // Stable per-(workspace, conversation, connection, REPO) key so
              // every turn of one conversation reuses ONE warm sandbox.
              // owner/name is part of the key: a different repo must never
              // silently reuse a previous repo's warm clone (the conversation
              // binding already makes a mid-conversation switch impossible —
              // this is defense in depth).
              sessionKey: `chat:${workspace.id}:${conversationId ?? requestId}:${codeMode.connectionId}:${codeMode.owner}/${codeMode.name}`,
              environmentId: codeMode.environmentId,
              repo: {
                owner: codeMode.owner,
                repo: codeMode.name,
                ref: branch,
                token,
              },
            });
          }
        }

        // Pinned chat context — the lightweight (no-sandbox) sibling of code
        // mode. Only present when the user pinned a repo/env AND is not in code
        // mode (the composer enforces that), so it never duplicates the
        // code-mode message. Rides as a per-turn USER message (ADR-021 §2).
        let pinnedContextMessage: ModelMessage | undefined;
        if (
          !codeMode &&
          pinnedContext &&
          (pinnedContext.repo || pinnedContext.environment)
        ) {
          const lines: string[] = ["## Pinned chat context"];
          if (pinnedContext.repo) {
            const branch =
              pinnedContext.repo.defaultBranch ?? "the default branch";
            lines.push(
              `Repository: ${pinnedContext.repo.owner}/${pinnedContext.repo.name} (default branch ${branch})`,
            );
          }
          if (pinnedContext.environment) {
            lines.push(`Environment: ${pinnedContext.environment.name}`);
          }
          lines.push(
            "The user pinned this to the conversation — treat it as the repository/environment they mean for repository, pull-request, diff, and CI requests unless they say otherwise. Do not ask which repository they mean.",
          );
          pinnedContextMessage = { role: "user", content: lines.join("\n") };
        }

        // ── @-mention references ──────────────────────────────────────────────
        // The user message may embed [:type|:slug|:location|:label] tokens
        // inserted by the composer's @-mention picker. Hydrate each unique
        // mention via search_references' exact-slug resolve mode (best-effort)
        // and ride the details as a per-turn USER message (ADR-021 §2), same
        // slot as the pinned/code context above. Mentioned graph nodes count
        // as citations — identical bookkeeping to automatic memory citations —
        // recorded fire-and-forget so they can never block the turn.
        const mentions = parseMentions(content);
        let referencesContextMessage: ModelMessage | undefined;
        if (mentions.length > 0) {
          const seenMentions = new Set<string>();
          const uniqueMentions = mentions
            .filter((m) => {
              const key = `${m.type}:${m.slug}`;
              if (seenMentions.has(key)) return false;
              seenMentions.add(key);
              return true;
            })
            .slice(0, 8);

          const hydrated = await runInTenantScope(
            { orgId: tenant.id, workspaceId: workspace.id },
            () =>
              Promise.all(
                uniqueMentions.map(async (mention) => {
                  try {
                    const out = (await invoke(
                      "search_references",
                      { slug: mention.slug, types: [mention.type], limit: 1 },
                      capCtx,
                      { surface: "agent" },
                    )) as {
                      results: Array<{
                        description: string | null;
                        properties: Record<string, unknown>;
                      }>;
                    };
                    return { mention, row: out.results[0] ?? null };
                  } catch {
                    return { mention, row: null };
                  }
                }),
              ),
          );

          const lines: string[] = [
            "## References (@-mentions)",
            "The user attached these references to this turn. Treat each as authoritative, already-cited context: resolve by id, prefer it over guessing, and never show the raw id as a name.",
          ];
          for (const { mention, row } of hydrated) {
            lines.push(
              `- [${mention.type}] ${mention.label}` +
                (mention.location ? ` — ${mention.location}` : "") +
                ` (id: ${mention.slug})` +
                (row?.description ? `: ${row.description}` : ""),
            );
            if (row && Object.keys(row.properties).length > 0) {
              const json = JSON.stringify(row.properties);
              lines.push(
                `  properties: ${json.length > 600 ? `${json.slice(0, 600)}…` : json}`,
              );
            }
            // A repository mention doubles as repo context when nothing is
            // pinned and code mode is off — same guidance the pinned-context
            // message gives, sourced from the mention's hydrated coordinates.
            if (
              mention.type === "repository" &&
              !codeMode &&
              !pinnedContext?.repo &&
              row &&
              typeof row.properties["owner"] === "string" &&
              typeof row.properties["name"] === "string"
            ) {
              const branch =
                typeof row.properties["defaultBranch"] === "string"
                  ? row.properties["defaultBranch"]
                  : "the default branch";
              lines.push(
                `  Treat ${row.properties["owner"]}/${row.properties["name"]} (default branch ${branch}) as the repository the user means for repository, pull-request, diff, and CI requests this turn.`,
              );
            }
          }
          referencesContextMessage = {
            role: "user",
            content: lines.join("\n"),
          };

          const nodeReferences = uniqueMentions
            .filter((m) => m.type === "node")
            .map((m) => ({ nodeId: m.slug }));
          if (nodeReferences.length > 0) {
            void runInTenantScope(
              { orgId: tenant.id, workspaceId: workspace.id },
              () =>
                invoke(
                  "cite_reference",
                  {
                    executionRef: capCtx.messageId ?? requestId,
                    references: nodeReferences,
                  },
                  capCtx,
                  { surface: "agent" },
                ),
            ).catch((err: unknown) => {
              logger.warn(
                { err, orgId: tenant.id, workspaceId: workspace.id },
                "[chat/stream] cite_reference for @-mentions failed (non-blocking)",
              );
            });
          }
        }

        const result = await executeTurn("chat", {
          ai,
          instruction: content,
          ...(codeWorkspace ? { workspace: codeWorkspace } : {}),
          // Current-turn image attachments (Phase 1) — resolved + fetched
          // above, org-scoped. Omitted entirely for a no-attachment turn so
          // the engine's plain-string content shape is unchanged (byte-
          // identical to before this feature for every existing caller).
          ...(imageAttachments.length > 0 ? { images: imageAttachments } : {}),
          // Current-turn video attachments (Phase 2) — only ever populated
          // when decideAttachmentRouting sent the turn down the video-capable
          // path (otherwise videos arrive as keyframe images above). Passed as
          // AI-SDK file parts by the engine.
          ...(videoAttachments.length > 0 ? { videos: videoAttachments } : {}),
          // Context messages, then the recalled-memory message LAST — the
          // exact position the engine's MemoryProvider used to inject it:
          // after the cached system prefix and every synthetic context block,
          // immediately before the instruction. The provider-shaped adapter is
          // gone (#1236's app-surface twin): no engine makes a mid-turn
          // recallContext() callback any more.
          history: [
            ...historyForEngine,
            ...([
              codeContextMessage,
              pinnedContextMessage,
              referencesContextMessage,
              pageContextMessage,
              recalledMemory.message,
            ].filter(Boolean) as ModelMessage[]),
          ],
          // Prompt layering: base (chat OR coding) → bound agent instructions.
          // The coding CONTRACT (codeModeSystemPrompt) must always sit ABOVE the
          // customer's agent instructions, so the bound instructions are
          // appended AFTER the base prompt, never merged into it.
          // `boundInstructions` is "" for an unbound turn ⇒ byte-identical
          // baseline. `useCodeModePrompt` is true when the request enabled code
          // mode OR the bound agent is a coding agent. Volatile page context is
          // NOT folded in here — it rides as a per-turn user message
          // (pageContextMessage) so the cached prefix stays byte-stable.
          system: resolvePrompt({
            key: "chat.system",
            baseline:
              (useCodeModePrompt
                ? codeModeSystemPrompt({
                    orgSlug,
                    workspaceSlug,
                    orgName: tenant.name,
                    workspaceName: workspace.name,
                    skillIndex,
                    pinnedSkillBodies,
                  })
                : chatSystemPrompt({
                    orgSlug,
                    workspaceSlug,
                    orgName: tenant.name,
                    workspaceName: workspace.name,
                    skillIndex,
                    pinnedSkillBodies,
                  })) +
              // Fold the bound agent's own instructions into the system prompt
              // so selecting an agent actually shapes its behavior, not just
              // the UI. `boundInstructions` is "" for an unbound turn ⇒
              // byte-identical baseline. Appended last so it can refine the
              // baseline.
              (boundInstructions
                ? `\n\n---\n\n## Agent instructions\n\n${boundInstructions}`
                : ""),
            config: promptConfig,
          }),
          model: modelId,
          ...(turnEffort ? { effort: turnEffort } : {}),
          // Runaway backstop for the agentic tool loop, NOT a functional limit.
          // Loop ends naturally on the model's final answer.
          maxSteps: DEFAULT_MAX_AGENT_STEPS,
          // Resilience: allow a small number of transient retries so a single
          // 429/5xx from the gateway does not kill the whole turn, and re-enable
          // the engine's context-overflow compaction retry (engine.ts:372) so an
          // overflow triggers one compact-and-retry instead of a hard error
          // event. The translator only forwards a step's parts once it finishes,
          // so a retried step does not double-stream to the client.
          maxRetries: CHAT_MAX_RETRIES,
          maxOverflowRetries: CHAT_MAX_OVERFLOW_RETRIES,
          extraTools: allTools,
          // Mutating capability aliases run behind the engine's exclusive
          // dispatch barrier (agent-engine v2 Phase 0) instead of the AI SDK's
          // unbounded parallel execution.
          mutatingToolNames,
          // NO `trace`: createClickHouseTraceStore writes up to 200 chars of the
          // raw instruction into ClickHouse, violating the chat surface's
          // hash-only prompt policy (C5). Per-step usage/credits still flow
          // through the metered AI port's streamAgentReply.
          signal: request.signal,
          onStreamPart: (part) => translator?.onPart(part),
          // Per-turn dollar budget (OXA — turn-budget). undefined when the
          // resolved policy is off — an unbudgeted turn runs exactly as
          // before this feature.
          budgetGuard,
        });

        const { assistantText, persistedBlocks } = translator.finish();

        // ── Per-turn next-step suggestions ─────────────────────────────────
        // Kick off conversation-aware suggestion generation NOW — the moment the
        // final answer text is known — so it runs concurrently with citation
        // resolution, persistence, and auto-titling below and adds minimal
        // latency. It self-times-out (6s) and returns null on any failure, so it
        // can never delay or break the turn; we await it just before [DONE].
        const suggestionsPromise: Promise<TurnSuggestion[] | null> =
          generateTurnSuggestions({
            recentTurns: buildRecentTurns(historyForEngine, {
              userText: content,
              assistantText,
            }),
            // Ground the suggestions in what the agent actually DID this turn
            // — capabilities invoked (with inputs + failures) and files
            // changed — so the chips name real files/errors/entities instead
            // of generic next steps. Both values already exist for memory
            // capture above; this adds no extra work to the turn.
            toolActivity: extractToolActivity(persistedBlocks),
            changedFiles: result.changedFiles,
            codeMode: useCodeModePrompt,
            orgId: tenant.id,
            workspaceId: workspace.id,
            messageId: requestId,
            orgSlug,
            workspaceSlug,
          });

        // ── Grounded-in citations ──────────────────────────────────────────
        // Surface the graph facts this answer was grounded in. The recalled
        // memories were injected into the model context above; here we resolve
        // them to their knowledge-graph node citations (already running) and
        // emit them as a `memory-recalled` event so the client renders a
        // "Grounded in" strip (NodeRef chips + View in graph) UNDER the answer.
        // Persisted as a trailing content block so it survives a refresh. The
        // await adds no first-token latency — resolution ran concurrently with
        // the whole turn — and never throws (the promise is catch-guarded).
        const citations = await citationsPromise;
        let blocksToPersist: AssistantContentBlock[] = persistedBlocks;
        if (citations.length > 0) {
          emit({
            type: "memory-recalled",
            queryId: capCtx.messageId,
            memories: citations,
          });
          blocksToPersist = [
            ...persistedBlocks,
            {
              type: "memory-recall",
              queryId: capCtx.messageId,
              memories: citations,
            },
          ];
        }

        // ONE aggregated usage event from the engine's summed per-step usage
        // (each step's own `finish` is suppressed by the translator). Credits are
        // charged per step inside streamAgentReply's onFinish — the ledger fans
        // out to one row per step sharing this turn's messageId, summing to the
        // same total the client sees here (C4).
        const emittedUsage = emitUsageEvent(emit, result.usage, modelId);

        await persistAssistantTurn(assistantText, blocksToPersist, {
          model: modelId,
          effort: turnEffort ?? null,
          durationMs: Date.now() - turnStartedAtMs,
          usage: emittedUsage,
        });

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

        // Await the (already-running) suggestion generation and emit it just
        // before the [DONE] sentinel. It self-times-out and resolves to null on
        // any failure, so this await is bounded and never throws — the turn is
        // already fully persisted above regardless of the outcome. `emit` no-ops
        // if the client disconnected, so a closed stream is handled for free.
        const suggestions = await suggestionsPromise;
        if (suggestions && suggestions.length > 0) {
          emit({ type: "suggested-prompts", suggestions });
        }
      } catch (err) {
        // Log server-side first: this catch covers model-framework crashes,
        // materializeTools failures, IAM kernel panics, and any unexpected
        // throw in the turn. Without this, agent-turn failures are invisible
        // in server logs and ClickHouse — an operator can't tell a transient
        // rate-limit from a recurring code defect.
        logger.error({ err, requestId }, "[chat/stream] turn error");
        // The engine THROWS on a provider/stream error or a client-disconnect
        // abort (where today an error PART did not throw). Flush + persist the
        // partial turn BEFORE emitting the error so a refresh still shows what
        // streamed, matching the old behaviour.
        if (translator) {
          const { assistantText, persistedBlocks } = translator.finish();
          await persistAssistantTurn(assistantText, persistedBlocks);
        }
        // Surface stream errors as a structured `error` event so the client can
        // show a readable toast. `formatStreamError` unwraps an API error
        // envelope (e.g. a 402 insufficient_credits body) into a clean
        // code+message — never a raw JSON string rendered inline on the page.
        const { code, message } = formatStreamError(err);
        emit({
          type: "error",
          messageId: requestId,
          message,
          ...(code !== undefined ? { code } : {}),
        });
      } finally {
        // Release the code-mode sandbox back to 'idle' WITHOUT tearing it down,
        // so the next turn of this conversation reconnects to the SAME warm
        // sandbox and its working tree (including uncommitted edits). The
        // sandbox-reaper drops it ~2-3 min after the last turn — recovering any
        // uncommitted work to a recovery branch first (spec:
        // sandbox-session-lifecycle). Must run whether the turn succeeded or threw.
        //
        // Guarded: a throwing release() must never skip the [DONE] sentinel and
        // the close() below, or the client's EventSource reader hangs until its
        // own timeout on every failed teardown.
        if (codeWorkspace) {
          try {
            await codeWorkspace.release();
          } catch (releaseErr) {
            logger.warn(
              { err: String(releaseErr), requestId },
              "[chat/stream] sandbox release failed — reaper will collect it",
            );
          }
        }
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
          } catch {
            // Controller may already be errored.
            closed = true;
          }
        }
        // close() THROWS on an already-closed/errored controller, and a throw
        // out of start() surfaces as an unhandled rejection.
        if (!closed) {
          try {
            controller.close();
          } catch {
            // Already closed by a client disconnect — nothing left to do.
          }
        }
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
