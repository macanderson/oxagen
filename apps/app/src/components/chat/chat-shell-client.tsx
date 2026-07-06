"use client";
import * as React from "react";
import { Suspense } from "react";
import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { MessageTree } from "./message-tree";
import { MessageComposer, type ComposerAction } from "./message-composer";
import type { ChatMessage, MessageBubbleCallbacks } from "./message-bubble";
import { PlanCard } from "./plan-card";
import { ApprovalCard } from "./approval-card";
import { ConsentCard } from "./consent-card";
import { ToolCallCard } from "./tool-call-card";
import { CodeExecuteCard } from "./code-execute-card";
import { MemoryCard } from "./memory-card";
import { BackgroundTaskCard } from "./background-task-card";
import { SubagentFanout } from "./subagent-fanout";
import { CHAT_COMPONENTS, logUnknownComponent, UnknownComponentCard } from "./chat-component-registry";
import { StreamingText } from "./streaming-text";
import { ReasoningCard } from "./reasoning-card";
import { ActivityTimeline, TimelineItem } from "./activity-timeline";
import { useToolStream } from "./use-tool-stream";
import type { ChatShellProps } from "./chat-shell";
import type { StreamEvent } from "./stream-event-types";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import type { ComposerModelState } from "./model-picker";
import type { McpServerSummary } from "./mcp-types";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import { SuggestedPromptChips } from "./suggested-prompt-chips";
import { ConversationFiles } from "./conversation-files";
import { useLatestRef } from "@/lib/use-latest-ref";
import type { FieldDescriptor } from "@/lib/ask/fill-types";
import { interceptFormFillEvents } from "./intercept-form-fill";
import { ThinkingBubble } from "./thinking-bubble";
import { MessageFooter } from "./message-footer";
import { useToast } from "@/components/ui/toast";

/**
 * Friendly toast title for a turn-level error, keyed off the machine `code`
 * parsed from the error envelope. Falls back to a generic title for unknown or
 * absent codes. The full human message goes in the toast description.
 */
function errorToastTitle(code: string | undefined): string {
  switch (code) {
    case "insufficient_credits":
    case "credit_balance_empty":
      return "Insufficient credits";
    case "billing_suspended":
      return "Billing suspended";
    case "rate_limited":
    case "rate_limit_exceeded":
      return "Rate limited";
    case "unauthorized":
    case "forbidden":
      return "Access denied";
    default:
      return "Request failed";
  }
}

/**
 * Serialisable page context forwarded from the current page to the stream
 * route. Mirrors the `pageContext` field in the route's BodySchema.
 */
export interface ChatPageContext {
  route: string;
  entitySummary?: string;
  fillableForm?: {
    formId: string;
    title: string;
    fields: FieldDescriptor[];
  };
}

// Client surface for the chat. The RSC `ChatShell` resolves the messages
// promise and hands them in; this component:
//  - threads the approval/plan resolvers down to the bubbles,
//  - blocks the composer while any approval-request block is still
//    awaiting a decision (spec §7 — "disabled while an approval is
//    pending"),
//  - calls POST /api/v1/chat/stream when a message is submitted, consumes
//    the SSE response via `useToolStream`, and renders live stream events
//    (plans, approvals, tool calls, code executes, memory recalls, memory
//    writes, fanouts) inline before the RSC revalidate completes,
//  - pauses the consume loop at `approval-required` events until the user
//    resolves the approval, ensuring intermediate states are observable,
//  - exposes a hook point for child-branch navigation that the subagent
//    fanout cards delegate to.
export function ChatShellClient({
  conversationId,
  conversationPublicId,
  activeLeafMessageId,
  messages,
  sendAction,
  resolveApprovalAction,
  resolveConsentAction,
  resolvePlanAction,
  agentCapabilities,
  orgSlug,
  workspaceSlug,
  modelConfig,
  enterToSubmit = false,
  pendingPromptBehavior = "queue",
  initialModelState,
  availableMcpServers,
  availableRepos,
  availableEnvironments,
  pageContext,
  onFormFillStart,
  onFormFillEnd,
  onConversationCreated,
  reloadMessages,
  showFiles = true,
}: {
  conversationId: string | null;
  /** publicId used for the files-panel fetch. */
  conversationPublicId: string | null;
  activeLeafMessageId: string | null;
  messages: ChatMessage[];
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolveConsentAction: ChatShellProps["resolveConsentAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
  agentCapabilities?: ChatShellProps["agentCapabilities"];
  orgSlug: string;
  workspaceSlug: string;
  modelConfig: ResolvedTierCatalog;
  /** Whether Enter key submits (from user prefs). Default false. */
  enterToSubmit?: boolean;
  /** What to do on concurrent submit (from user prefs). Default 'queue'. */
  pendingPromptBehavior?: "queue" | "interrupt";
  /** Initial model state seeded from effective server defaults. */
  initialModelState?: ComposerModelState;
  /** Available MCP servers for the per-turn activation picker. */
  availableMcpServers?: McpServerSummary[];
  /** GitHub repos usable as the code-mode target (see _shared/code-mode-data.ts). */
  availableRepos?: RepoOption[];
  /** Workspace environments usable as the code-mode target. */
  availableEnvironments?: EnvironmentOption[];
  /**
   * Page context forwarded from the current page. When a fillable form is
   * registered (e.g. in AskDrawer/WandPanel wrappers), this is passed to the
   * /api/v1/chat/stream body so the server can inject the `page_form_fill` tool.
   */
  pageContext?: ChatPageContext | null;
  /**
   * Called when the agent starts invoking `page_form_fill` (tool-call-start).
   * Use this to set isFilling=true in PageContext.
   */
  onFormFillStart?: () => void;
  /**
   * Called when `page_form_fill` completes (tool-call-end) with the fill result.
   * Use this to set fillResult in PageContext.
   */
  onFormFillEnd?: (result: import("@/lib/ask/fill-types").FormFillResult) => void;
  /**
   * Embedded mode (e.g. the floating in-app agent panel): the embedder owns the
   * conversation state instead of the RSC. When provided, ChatShellClient calls
   * this on the turn that creates the conversation (with the new ids) INSTEAD of
   * pinning the browser URL via router.replace — the floating panel has no route
   * of its own to pin.
   */
  onConversationCreated?: (conversationId: string, conversationPublicId: string) => void;
  /**
   * Embedded mode: called after a turn completes to reconcile the live stream
   * with the persisted messages. When provided it REPLACES the router.refresh()
   * the full /ask page relies on — the embedder reloads its `messages` prop from
   * the server (e.g. via a server action) so the just-persisted user + assistant
   * turn becomes durable instead of vanishing on the next send.
   */
  reloadMessages?: () => void | Promise<void>;
  /**
   * Whether to render the conversation-files toolbar trigger. Default true. The
   * floating in-app panel hides it (files live on the full /ask page, reachable
   * via "Open in conversations").
   */
  showFiles?: boolean;
}) {
  const {
    plans,
    pendingApprovals,
    pendingConsents,
    toolCalls,
    reasonings,
    steps,
    textSegments,
    memoryRecalls,
    memoryWrites,
    activeFanouts,
    components: liveComponents,
    backgroundTasks,
    order,
    turnUsage,
    turnError,
    turnWarning,
    turnBudgetNotice,
    consume,
    reset,
    hasBlockingApproval,
    hasBlockingConsent,
    signalApprovalResolved,
    signalConsentResolved,
  } = useToolStream();

  // Surface a turn-level failure (provider/gateway error, billing block such as
  // insufficient_credits, or an unexpected server throw) as a toast — instead of
  // letting the raw error envelope render inline as unreadable JSON.
  //
  // `useToast()` returns a fresh manager object each render, so we dedupe by the
  // error's CONTENT (not object identity): the effect may run on every render,
  // but `add()` fires exactly once per distinct failure. Without this guard,
  // adding a toast re-renders the subtree → effect re-runs → adds again, an
  // infinite update loop. The key resets when the turn is cleared so the next
  // failure toasts again.
  const toast = useToast();
  const lastToastedErrorRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (turnError === undefined) {
      lastToastedErrorRef.current = null;
      return;
    }
    const key = `${turnError.code ?? ""}::${turnError.message}`;
    if (lastToastedErrorRef.current === key) return;
    lastToastedErrorRef.current = key;
    toast.add({
      type: "error",
      title: errorToastTitle(turnError.code),
      description: turnError.message,
    });
  }, [turnError, toast]);

  // Non-fatal advisory (e.g. the reply failed to persist to history): toast it
  // as a warning so the user knows, without marking the turn failed. Same
  // dedupe-by-content guard as the turnError effect above.
  const lastToastedWarningRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (turnWarning === undefined) {
      lastToastedWarningRef.current = null;
      return;
    }
    const key = `${turnWarning.code ?? ""}::${turnWarning.message}`;
    if (lastToastedWarningRef.current === key) return;
    lastToastedWarningRef.current = key;
    toast.add({
      type: "warning",
      title: "Heads up",
      description: turnWarning.message,
    });
  }, [turnWarning, toast]);

  // Per-turn dollar budget (OXA — turn-budget): surface the engine's non-
  // blocking budget-guard notices as a toast, same dedupe-by-content pattern
  // as the turnError effect above (a new object identity every render must
  // not re-toast the same notice). "stopped" ends the turn early (mirrors the
  // engine's `stopReason: "budget"`); "within_grace" is informational and the
  // turn keeps streaming. The gated "prompt" mode's pause is NOT here — it
  // renders as an approval card via pendingApprovals instead.
  const lastToastedBudgetNoticeRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (turnBudgetNotice === undefined) {
      lastToastedBudgetNoticeRef.current = null;
      return;
    }
    const key = `${turnBudgetNotice.state} ${turnBudgetNotice.costUsd} ${turnBudgetNotice.limitUsd}`;
    if (lastToastedBudgetNoticeRef.current === key) return;
    lastToastedBudgetNoticeRef.current = key;
    const cost = turnBudgetNotice.costUsd.toFixed(4);
    const limit = turnBudgetNotice.limitUsd.toFixed(4);
    if (turnBudgetNotice.state === "stopped") {
      toast.add({
        type: "warning",
        title: "Turn stopped — per-turn budget reached",
        description: `This turn cost $${cost} of your $${limit} budget and was stopped.`,
      });
    } else {
      toast.add({
        type: "info",
        title: "Over budget — within grace window",
        description: `This turn is at $${cost}, past your $${limit} budget but still inside the grace cushion.`,
      });
    }
  }, [turnBudgetNotice, toast]);

  const router = useRouter();
  const pathname = usePathname();

  // Track whether the current turn is streaming (to show live events).
  const [isStreaming, setIsStreaming] = React.useState(false);
  const isStreamingValueRef = useLatestRef(isStreaming);

  // Stream error — set when the SSE fetch returns a non-2xx response or throws
  // a non-abort error. Cleared at the start of each new turn.
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const setStreamErrorRef = useLatestRef(setStreamError);

  // Latest conversationId, read inside the send callback (whose deps don't
  // include it) to tell whether THIS turn created the conversation.
  const conversationIdRef = useLatestRef(conversationId);

  // Set after a completed turn triggers router.refresh(). When the server then
  // re-renders `messages` (now including the just-persisted assistant reply),
  // we clear the live SSE state so the streamed bubbles are replaced by their
  // persisted equivalents — no duplicate, no flash, and they survive the next
  // submit's reset because they now live in the immutable `messages` prop.
  // Deferred while a new turn is mid-stream so a concurrent submit's revalidate
  // can't wipe the in-flight live text; the flag carries to that turn's end.
  const awaitingReconcileRef = React.useRef(false);
  React.useEffect(() => {
    if (awaitingReconcileRef.current && !isStreamingValueRef.current) {
      awaitingReconcileRef.current = false;
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isStreamingValueRef is a stable ref; its identity never changes
  }, [messages, reset]);

  // Stable refs so useCallback deps don't change on every render.
  const consumeRef = useLatestRef(consume);
  const resetRef = useLatestRef(reset);
  const signalRef = useLatestRef(signalApprovalResolved);
  const consentSignalRef = useLatestRef(signalConsentResolved);
  const orgSlugRef = useLatestRef(orgSlug);
  const workspaceSlugRef = useLatestRef(workspaceSlug);
  const setIsStreamingRef = useLatestRef(setIsStreaming);
  // Page-form-fill callback refs — stable so wrappedSendAction deps don't change.
  const pageContextRef = useLatestRef(pageContext ?? null);
  const onFormFillStartRef = useLatestRef(onFormFillStart ?? null);
  const onFormFillEndRef = useLatestRef(onFormFillEnd ?? null);
  // Embedded-mode callback refs (floating in-app panel). When set, they replace
  // the router-based URL pin + refresh reconciliation that the /ask page uses.
  const onConversationCreatedRef = useLatestRef(onConversationCreated ?? null);
  const reloadMessagesRef = useLatestRef(reloadMessages ?? null);

  // AbortController for the in-flight SSE fetch. A new controller is created
  // for every turn. Aborted on interrupt and on unmount.
  const abortControllerRef = React.useRef<AbortController | null>(null);

  // Abort the current stream on unmount to prevent orphaned SSE readers
  // writing into unmounted state.
  React.useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // hasPendingApproval: blocked either by a persisted block (DB) or a live
  // stream approval event that hasn't been resolved yet.
  const hasPersistentPendingApproval = React.useMemo(
    () =>
      messages.some((m) =>
        (m.contentBlocks ?? []).some(
          (b) => b.type === "approval-request" && b.resolution === undefined,
        ),
      ),
    [messages],
  );
  // The composer is blocked while EITHER an approval-request or a first-use
  // external-MCP consent prompt is still awaiting a decision — both pause the
  // agent stream and must be resolved before the next turn can be sent.
  const hasPendingApproval =
    hasPersistentPendingApproval || hasBlockingApproval || hasBlockingConsent;

  // Wrap the approval resolver to also unblock the `consume` loop when the
  // user resolves an approval. Without this, the consume loop pauses after
  // `approval-required` and will never continue until signalled.
  const wrappedResolveApproval = React.useCallback<
    ChatShellProps["resolveApprovalAction"]
  >(
    async (approvalId, decision) => {
      // Signal the consume loop immediately (before the server action
      // completes) so the stream unblocks and subsequent events begin
      // rendering right away.
      signalRef.current(approvalId);
      return resolveApprovalAction(approvalId, decision);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signalRef is a stable ref via useLatestRef; adding it would defeat the pattern
    [resolveApprovalAction],
  );

  // Mirror wrappedResolveApproval for first-use external-MCP consent (OXA-816):
  // signal the consume loop first (so the paused stream unblocks immediately on
  // a `consent-required` pause), then call the server action.
  const wrappedResolveConsent = React.useCallback<
    ChatShellProps["resolveConsentAction"]
  >(
    async (approvalId, decision, grantAllTools) => {
      consentSignalRef.current(approvalId);
      return resolveConsentAction(approvalId, decision, grantAllTools);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consentSignalRef is a stable ref via useLatestRef; adding it would defeat the pattern
    [resolveConsentAction],
  );

  // Wrap the server action: persist the turn (server action) FIRST to obtain
  // the conversation id and the new user-message id, then start the
  // /api/v1/chat/stream SSE fetch against them. The stream route is the single
  // LLM caller and persists the assistant reply once the stream finishes.
  // Persisting before streaming also gives us a conversation id on the very
  // first turn (the composer has none yet) and removes the history-read race.
  const wrappedSendAction = React.useCallback<ComposerAction>(
    async (formData: FormData) => {
      const content = formData.get("content");
      if (typeof content !== "string" || content.length === 0) {
        return sendAction(formData);
      }

      // Reset prior turn's live state and show the streaming affordance.
      resetRef.current();
      setStreamErrorRef.current(null);
      setIsStreamingRef.current(true);

      const wasNewConversation = !conversationIdRef.current;
      const result = await sendAction(formData);
      if (!result.ok || !result.conversationId) {
        // Persistence failed (or yielded no conversation): don't stream; the
        // result drives the composer's error state.
        setIsStreamingRef.current(false);
        return result;
      }

      // If this turn created the conversation, make it durable. In embedded mode
      // (floating in-app panel) hand the new ids to the embedder so it can adopt
      // the conversation in its own state — the panel has no route to pin. On the
      // full /ask page, pin the browser URL to the conversation's public id:
      // without `?c=<publicId>` the bare /ask|/chat URL resolves to a blank slate,
      // so the new conversation's persisted history would never render (and the
      // next turn would spawn yet another conversation). The immediate
      // router.refresh() also updates the conversation nav list right away — the
      // DB row exists as soon as sendAction returns.
      if (wasNewConversation && result.conversationPublicId) {
        if (onConversationCreatedRef.current) {
          onConversationCreatedRef.current(result.conversationId, result.conversationPublicId);
        } else {
          router.replace(`${pathname}?c=${result.conversationPublicId}`);
          router.refresh();
        }
      }

      void (async () => {
        // Create a fresh AbortController for this turn. Any previous controller
        // is already aborted (either by interrupt or by the previous turn's
        // natural completion).
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const { signal } = controller;

        try {
          const res = await fetch("/api/v1/chat/stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              content,
              conversationId: result.conversationId,
              parentMessageId: result.userMessageId ?? null,
              newConversation: wasNewConversation,
              orgSlug: orgSlugRef.current,
              workspaceSlug: workspaceSlugRef.current,
              tier: (formData.get("tier") as string) || null,
              model: (formData.get("model") as string) || null,
              effort: (formData.get("effort") as string) || null,
              generate: (formData.get("generate") as string) || null,
              mediaTier: (formData.get("mediaTier") as string) || null,
              mediaModel: (formData.get("mediaModel") as string) || null,
              activeServerIds: (() => {
                const raw = formData.get("activeServerIds") as string | null;
                if (!raw) return [];
                try { return JSON.parse(raw) as string[]; } catch { return []; }
              })(),
              // Per-turn dollar budget (OXA — turn-budget). The composer
              // always sets this (see message-composer.tsx budgetPayload) but
              // a malformed/missing value degrades to `null`, which the route
              // treats as "no per-turn override" and falls back to the user's
              // saved default (budget.policy.read).
              budget: (() => {
                const raw = formData.get("budget") as string | null;
                if (!raw) return null;
                try { return JSON.parse(raw); } catch { return null; }
              })(),
              // Forward attachment IDS ONLY — never the base64 bytes or the
              // full conversationAssetItem the composer persisted — the stream
              // route re-resolves each publicId server-side (ownership +
              // status='ready' + kind allowlist) before building image parts.
              // Keeps the 32 KiB BodySchema `content` cap meaningful (the
              // four-store rule: refs-by-publicId through the wire, bytes stay
              // in blob storage).
              attachments: (() => {
                const raw = formData.get("attachments") as string | null;
                if (!raw) return [];
                try {
                  const parsed = JSON.parse(raw) as Array<{
                    publicId?: unknown;
                    keyframeForVideo?: unknown;
                  }>;
                  return parsed
                    .filter((a) => typeof a.publicId === "string")
                    .map((a) => ({
                      publicId: a.publicId as string,
                      // Preserve the video↔keyframe link (Phase 2) so the route
                      // can drop a video's sampled keyframes when it sends the
                      // real video file part instead.
                      ...(typeof a.keyframeForVideo === "string"
                        ? { keyframeForVideo: a.keyframeForVideo }
                        : {}),
                    }));
                } catch {
                  return [];
                }
              })(),
              // Forward page context so the route can inject the page_form_fill tool.
              pageContext: pageContextRef.current ?? null,
              // Code-mode sandbox target (OXA app-code-mode). The composer only
              // sets this formData field when Code mode is ON and both a repo
              // and environment are selected (see message-composer.tsx's send
              // gate) — otherwise this is `null`, matching the stream route's
              // BodySchema `code: {...} | null`.
              code: (() => {
                const raw = formData.get("code") as string | null;
                if (!raw) return null;
                try {
                  return JSON.parse(raw) as unknown;
                } catch {
                  return null;
                }
              })(),
            }),
          });

          if (!res.ok || !res.body) {
            const errMsg = `Stream request failed (HTTP ${res.status})`;
            console.warn("[chat]", errMsg);
            setStreamErrorRef.current(errMsg);
            setIsStreamingRef.current(false);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();

          // Wrap the SSE event stream to intercept page_form_fill tool events
          // before they reach the reducer. On tool-call-start we signal that a
          // fill is in progress; on tool-call-end we surface the fill result.
          const rawStream = sseToEvents(reader, decoder, signal);
          const fillAwareStream = interceptFormFillEvents(
            rawStream,
            onFormFillStartRef.current,
            onFormFillEndRef.current,
          );
          await consumeRef.current(fillAwareStream);

          // Turn finished cleanly: pull the now-persisted user + assistant turn
          // into the `messages` prop. The [messages] effect above then clears the
          // live state once the refreshed prop lands, so the turn becomes durable
          // persisted bubbles instead of vanishing on the next submit. Embedded
          // mode reloads via the embedder's server action (no RSC to refresh);
          // the /ask page uses router.refresh() to re-run its RSC.
          if (abortControllerRef.current === controller) {
            awaitingReconcileRef.current = true;
            if (reloadMessagesRef.current) {
              await reloadMessagesRef.current();
            } else {
              router.refresh();
            }
          }
        } catch (err) {
          // AbortError is expected on interrupt or unmount — not a warning.
          if (err instanceof Error && err.name !== "AbortError") {
            // Non-abort stream failures (network drop, mid-stream server crash,
            // ReadableStream error). Surface to the user so they know to retry
            // instead of silently leaving a blank or truncated assistant turn.
            const msg = err.message || "Stream connection lost";
            console.warn("[chat] stream fetch failed", err);
            setStreamErrorRef.current(msg);
          }
        } finally {
          // Only clear isStreaming when this controller is still the active one
          // (prevents a stale interrupt callback from clearing a newly started
          // stream's streaming flag).
          if (abortControllerRef.current === controller) {
            setIsStreamingRef.current(false);
          }
        }
      })();

      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- *Ref values are stable refs via useLatestRef; adding them would defeat the pattern
    [sendAction, router, pathname],
  );

  // Called by the composer when the user wants to interrupt the in-flight stream.
  const handleInterrupt = React.useCallback(() => {
    abortControllerRef.current?.abort();
    // Reset live state immediately so the partial turn is cleaned up.
    resetRef.current();
    setIsStreamingRef.current(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- *Ref values are stable refs via useLatestRef; no dependencies needed
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-scroll: always follow content to the bottom unless the user has
  // manually scrolled up mid-turn. Three triggers:
  //   1. isStreaming becomes true (user submitted) → force-jump + re-enable.
  //   2. order / textSegments change (SSE deltas) → follow if at bottom.
  //   3. messages prop updates (history load / persisted reply) → follow.
  // All use direct scrollTop assignment (instant, idempotent, no stacking
  // scroll-animation jank) instead of scrollTo({behavior:'smooth'}).
  // ---------------------------------------------------------------------------
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  // True while the user is at (or near) the bottom of the scroll container.
  // Reset to true every time a new turn starts so new turns always auto-follow.
  const shouldAutoScrollRef = React.useRef(true);

  const scrollToBottom = React.useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Scroll to the bottom on initial mount so persisted history shows the
  // most recent messages without a flash of the top. useLayoutEffect fires
  // synchronously after DOM mutations but before paint.
  React.useLayoutEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force-scroll + re-enable auto-scroll when the user submits a new turn.
  React.useEffect(() => {
    if (isStreaming) {
      shouldAutoScrollRef.current = true;
      scrollToBottom();
    }
  }, [isStreaming, scrollToBottom]);

  // Follow content as SSE deltas arrive. `order` grows with each new timeline
  // entry; `textSegments` reference changes on every text delta. React already
  // re-renders on these — we just piggyback the scroll.
  React.useEffect(() => {
    if (shouldAutoScrollRef.current) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, textSegments]);

  // Scroll when the persisted messages prop updates (history load or after
  // router.refresh() completes and the RSC reply lands).
  React.useEffect(() => {
    if (shouldAutoScrollRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // Detect when the user scrolls up mid-turn — disable auto-scroll so we
  // don't yank them back. Re-enable automatically once they're near the bottom.
  const handleScroll = React.useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // "Near the bottom" = within 80px (accounts for mobile rubber-banding
    // and 1px rounding differences across browsers).
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = fromBottom < 80;
  }, []);

  // Stable identity: this object is passed to the memoized <MessageTree>. Rebuilt
  // inline it would change every render (every streaming token re-renders this
  // component), defeating the memo and re-rendering the entire persisted message
  // tree on each token. Its deps are all stable (two useCallbacks + two props).
  const callbacks: MessageBubbleCallbacks = React.useMemo(
    () => ({
      onResolveApproval: wrappedResolveApproval,
      onResolveConsent: wrappedResolveConsent,
      onResolvePlan: resolvePlanAction,
      agentCapabilities,
      onNavigateToChild: (childMessageId: string) => {
        if (typeof window !== "undefined") {
          window.location.hash = `m-${childMessageId}`;
        }
      },
    }),
    [wrappedResolveApproval, wrappedResolveConsent, resolvePlanAction, agentCapabilities],
  );

  // The live turn renders as a single ORDERED timeline (the chain of
  // thought/action): the reducer records every entity's first appearance in
  // `order`, and we walk it here so reasoning → tool → text interleave in true
  // stream order rather than in fixed per-category groups.
  const stepCount = Object.keys(steps).length;
  const hasLiveContent = isStreaming || order.length > 0;

  // Resolve one ordered timeline key (`<kind>:<id>`) to its card plus the
  // tone/active flags the TimelineItem rail uses. Returns null when the entity
  // isn't renderable yet (e.g. an empty text segment).
  const renderEntry = (
    key: string,
  ): { node: React.ReactNode; tone: TimelineTone; active: boolean } | null => {
    const sep = key.indexOf(":");
    const kind = key.slice(0, sep);
    const id = key.slice(sep + 1);
    switch (kind) {
      case "reasoning": {
        const r = reasonings[id];
        if (!r) return null;
        return {
          node: (
            <ReasoningCard text={r.text} status={r.status} durationMs={r.durationMs} />
          ),
          tone: r.status === "thinking" ? "thinking" : "done",
          active: r.status === "thinking",
        };
      }
      case "step": {
        // Single-step turns add no information — skip the marker noise.
        if (stepCount <= 1) return null;
        const s = steps[Number(id)];
        if (!s) return null;
        return {
          node: <StepMarker index={s.stepIndex} status={s.status} />,
          tone: s.status === "running" ? "running" : "done",
          active: s.status === "running",
        };
      }
      case "tool": {
        const tc = toolCalls[id];
        if (!tc) return null;
        const tone: TimelineTone =
          tc.status === "completed"
            ? "done"
            : tc.status === "failed"
              ? "failed"
              : "running";
        const active = tc.status === "pending" || tc.status === "running";
        if (tc.capability === "agent.code.execute") {
          const preview = (tc.inputPreview as Record<string, unknown> | null) ?? {};
          const language = typeof preview.language === "string" ? preview.language : "node";
          const code = typeof preview.code === "string" ? preview.code : "";
          const outputRecord = (tc.output as Record<string, unknown> | null) ?? {};
          const exitCode =
            typeof outputRecord.exitCode === "number" ? outputRecord.exitCode : undefined;
          return {
            node: (
              <CodeExecuteCard
                toolCallId={tc.toolCallId}
                language={language}
                code={code}
                status={tc.status}
                stdout={tc.stdout}
                stderr={tc.stderr}
                exitCode={exitCode}
                durationMs={tc.durationMs}
              />
            ),
            tone,
            active,
          };
        }
        return {
          node: (
            <ToolCallCard
              toolCallId={tc.toolCallId}
              capability={tc.capability}
              // While args are still streaming, show the partial JSON; once the
              // parsed input lands we show the structured preview.
              inputPreview={
                tc.status === "pending" ? tc.partialInput ?? "" : tc.inputPreview
              }
              riskLevel={tc.riskLevel}
              status={tc.status}
              output={tc.output}
              stdout={tc.stdout}
              stderr={tc.stderr}
              errorReason={tc.errorReason}
              durationMs={tc.durationMs}
              // Auto-expand the in-flight call so the user watches the agent
              // compose its arguments and stream output live.
              defaultOpen={active}
            />
          ),
          tone,
          active,
        };
      }
      case "text": {
        const seg = textSegments[key];
        if (!seg || !seg.text) return null;
        return {
          node: (
            <StreamingText text={seg.text} isStreaming={isStreaming} className="text-sm" />
          ),
          tone: "idle",
          active: false,
        };
      }
      case "plan": {
        const plan = plans[id];
        if (!plan) return null;
        return {
          node: (
            <PlanCard
              planId={plan.planId}
              title={plan.title}
              steps={plan.steps}
              rationale={plan.rationale}
              status={plan.status}
              agentCapabilities={agentCapabilities}
              onResolve={resolvePlanAction}
            />
          ),
          tone: plan.status === "pending" ? "running" : "done",
          active: plan.status === "pending",
        };
      }
      case "approval": {
        const a = pendingApprovals[id];
        if (!a) return null;
        return {
          node: (
            <ApprovalCard
              approvalId={a.approvalId}
              capability={a.capability}
              inputPreview={a.inputPreview}
              riskLevel={a.riskLevel}
              expiresAt={a.expiresAt}
              resolution={a.resolution}
              onResolved={wrappedResolveApproval}
            />
          ),
          tone: a.resolution ? "done" : "running",
          active: a.resolution === undefined,
        };
      }
      case "consent": {
        const c = pendingConsents[id];
        if (!c) return null;
        return {
          node: (
            <ConsentCard
              approvalId={c.approvalId}
              capability={c.capability}
              serverId={c.serverId}
              toolName={c.toolName}
              inputPreview={c.inputPreview}
              expiresAt={c.expiresAt}
              resolution={c.resolution}
              onResolved={wrappedResolveConsent}
            />
          ),
          tone: c.resolution ? "done" : "running",
          active: c.resolution === undefined,
        };
      }
      case "memory": {
        const mr = memoryRecalls[id];
        if (!mr) return null;
        return {
          node: <MemoryCard queryId={mr.queryId} memories={mr.memories} />,
          tone: "done",
          active: false,
        };
      }
      case "memwrite": {
        const w = memoryWrites[id];
        if (!w) return null;
        return {
          node: (
            <MemoryCard
              queryId={w.memoryId}
              memories={[
                {
                  id: w.memoryId,
                  lesson: `Memory written → ${w.nodeRef}`,
                  memoryClass: w.memoryClass,
                  memoryKind: "gotcha",
                  confidenceScore: 100,
                  enforcementScore: w.enforcementScore,
                  score: 1,
                  nodeRef: w.nodeRef,
                },
              ]}
            />
          ),
          tone: "done",
          active: false,
        };
      }
      case "fanout": {
        const f = activeFanouts[id];
        if (!f) return null;
        return {
          node: (
            <SubagentFanout
              fanoutId={f.fanoutId}
              parentMessageId={f.parentMessageId}
              subagents={f.children}
              status={f.status}
              results={f.results}
              onSelectChild={callbacks.onNavigateToChild}
            />
          ),
          tone:
            f.status === "completed"
              ? "done"
              : f.status === "running"
                ? "running"
                : "failed",
          active: f.status === "running",
        };
      }
      case "component": {
        const lc = liveComponents[id];
        if (!lc) return null;
        const Component = CHAT_COMPONENTS[lc.componentId];
        if (!Component) {
          // Unknown componentId — log for observability and return a visible
          // fallback entry so the user sees a clear signal instead of silence.
          logUnknownComponent(lc.componentId);
          return {
            node: <UnknownComponentCard componentId={lc.componentId} />,
            tone: "done" as const,
            active: false,
          };
        }
        return {
          node: (
            <Suspense fallback={<ComponentSkeleton />}>
              <Component {...lc.props} />
            </Suspense>
          ),
          tone: "done",
          active: false,
        };
      }
      case "bgtask": {
        const t = backgroundTasks[id];
        if (!t) return null;
        const tone: TimelineTone =
          t.status === "completed"
            ? "done"
            : t.status === "failed"
              ? "failed"
              : t.status === "cancelled"
                ? "idle"
                : "running";
        const active = t.status === "pending" || t.status === "running";
        return {
          node: (
            <BackgroundTaskCard
              taskId={t.taskId}
              kind={t.kind}
              label={t.label}
              status={t.status}
              inngestRunId={t.inngestRunId}
              progressPct={t.progressPct}
            />
          ),
          tone,
          active,
        };
      }
      default:
        return null;
    }
  };

  const timelineEntries = order
    .map((key) => ({ key, rendered: renderEntry(key) }))
    .filter(
      (e): e is { key: string; rendered: NonNullable<ReturnType<typeof renderEntry>> } =>
        e.rendered !== null,
    );

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4">
      {/* Toolbar row: files panel trigger (right-aligned). Hidden in the
          floating in-app panel (showFiles=false) — conversation files live on
          the full /ask page, reachable via "Open in conversations". */}
      {showFiles ? (
        <div className="flex shrink-0 items-center justify-end">
          <ConversationFiles conversationPublicId={conversationPublicId} />
        </div>
      ) : null}

      <div
        ref={scrollContainerRef}
        // `relative` is load-bearing: it makes this scroll container the
        // containing block for its absolutely-positioned descendants (e.g. the
        // `.sr-only` labels inside message-footer icon buttons). Without it
        // those abs elements anchor to the initial containing block, escape this
        // container's `overflow` clipping, and inflate the document height —
        // letting the whole page scroll past the composer on mobile and desktop.
        className="relative min-h-0 flex-1 overflow-y-auto pr-2"
        onScroll={handleScroll}
      >
        {messages.length === 0 && !hasLiveContent ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-sm text-muted-foreground">
            <div>
              <p className="font-medium">Start a conversation.</p>
              <p>Send a message below to begin.</p>
            </div>
            {/* Suggested chips in empty state */}
            <SuggestedPromptChips
              action={wrappedSendAction}
              conversationId={conversationId}
              parentMessageId={activeLeafMessageId}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <MessageTree
              messages={messages}
              callbacks={callbacks}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
            {/* Live turn: the ordered chain of thought/action, rendered as a
                connected timeline before the RSC revalidate replaces it with
                the persisted message. */}
            {hasLiveContent ? (
              <div data-live-turn>
                <ActivityTimeline>
                  {/* Show the thinking bubble when streaming has started but no
                      timeline entries have arrived yet — covers the gap between
                      the user submitting and the first SSE event landing. */}
                  {isStreaming && timelineEntries.length === 0 ? (
                    <TimelineItem
                      key="thinking-bubble"
                      tone="thinking"
                      isActive={true}
                      isLast={true}
                    >
                      <ThinkingBubble />
                    </TimelineItem>
                  ) : null}
                  {timelineEntries.map((entry, i) => (
                    <TimelineItem
                      key={entry.key}
                      tone={entry.rendered.tone}
                      // The pulsing ring only animates an in-flight node while the
                      // turn is actually streaming.
                      isActive={entry.rendered.active && isStreaming}
                      isLast={
                        i === timelineEntries.length - 1 && turnUsage === undefined
                      }
                    >
                      {entry.rendered.node}
                    </TimelineItem>
                  ))}
                </ActivityTimeline>
                {turnUsage !== undefined ? (
                  <MessageFooter
                    text={Object.values(textSegments)
                      .map((s) => s.text)
                      .join("")}
                    usage={turnUsage}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {/* Suggested prompt chips — shown above the composer once there are messages
          (empty state renders its own chips above; this avoids duplication). */}
      {messages.length > 0 || hasLiveContent ? (
        <SuggestedPromptChips
          action={wrappedSendAction}
          conversationId={conversationId}
          parentMessageId={activeLeafMessageId}
          className="justify-center"
        />
      ) : null}

      {/* Stream error banner — visible when an SSE fetch fails (non-2xx or
          mid-stream network error) so the user knows to retry. Cleared
          automatically on the next send. */}
      {streamError ? (
        <div
          role="alert"
          data-testid="stream-error-banner"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {streamError} — please try again.
        </div>
      ) : null}

      <MessageComposer
        conversationId={conversationId}
        parentMessageId={activeLeafMessageId}
        action={wrappedSendAction}
        disabled={hasPendingApproval}
        modelConfig={modelConfig}
        enterToSubmit={enterToSubmit}
        pendingPromptBehavior={pendingPromptBehavior}
        isStreaming={isStreaming}
        onInterrupt={handleInterrupt}
        initialModelState={initialModelState}
        availableMcpServers={availableMcpServers}
        availableRepos={availableRepos}
        availableEnvironments={availableEnvironments}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}

// Tone of a timeline node's rail dot — mirrors TimelineItem's `tone` prop.
type TimelineTone = "thinking" | "running" | "done" | "failed" | "idle";

// Subtle multi-step boundary marker, shown only when a turn has >1 step. Reads
// as a quiet divider in the timeline rather than a card.
function StepMarker({
  index,
  status,
}: {
  index: number;
  status: "running" | "done";
}) {
  return (
    <div
      className="flex items-center gap-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
      data-component="step-marker"
      data-status={status}
    >
      <span>Step {index + 1}</span>
      {status === "running" ? (
        <span className="text-info">·  working</span>
      ) : null}
    </div>
  );
}

// Shared loading skeleton for a lazily-rendered registry component.
function ComponentSkeleton() {
  return (
    <div
      className={cn("rounded-xl border bg-card px-4 py-3", "animate-pulse space-y-2")}
      aria-busy="true"
      aria-label="Loading component"
    >
      <div className="h-3 w-2/3 rounded bg-muted-foreground/20" />
      <div className="h-3 w-1/2 rounded bg-muted-foreground/15" />
    </div>
  );
}

// Parse a ReadableStream of raw SSE bytes into an async iterable of
// StreamEvent objects. Handles partial-line buffering across read() calls
// and emits each event when `data: [DONE]` is NOT reached.
// When the AbortSignal fires the generator exits cleanly (the caller's fetch
// already threw AbortError, but in case the body reader is mid-read we also
// check signal.aborted on each iteration so the reader releases promptly).
async function* sseToEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done || signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as StreamEvent;
          } catch {
            // Skip malformed JSON lines.
          }
        }
      }
    }
  } finally {
    // Always release the lock so the response body can be GC'd.
    reader.releaseLock();
  }
}
