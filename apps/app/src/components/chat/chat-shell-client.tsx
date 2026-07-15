"use client";
import * as React from "react";
import { Suspense } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { MessageTree } from "./message-tree";
import { MessageComposer, type ComposerAction } from "./message-composer";
import type { ChatMessage, MessageBubbleCallbacks } from "./message-bubble";
import { PlanCard } from "./plan-card";
import { ApprovalCard } from "./approval-card";
import { ConsentCard } from "./consent-card";
import {
  ToolActivityGroup,
  type ToolActivityItem,
} from "./tool-activity-group";
import { CodeExecuteCard } from "./code-execute-card";
import { MemoryCard } from "./memory-card";
import { BackgroundTaskCard } from "./background-task-card";
import { SubagentFanout } from "./subagent-fanout";
import {
  CHAT_COMPONENTS,
  logUnknownComponent,
  UnknownComponentCard,
} from "./chat-component-registry";
import { StreamingText } from "./streaming-text";
import { ReasoningCard } from "./reasoning-card";
import { ActivityTimeline, TimelineItem } from "./activity-timeline";
import { useToolStream } from "./use-tool-stream";
import type { ChatShellProps } from "./chat-shell-props";
import type { StreamEvent } from "./stream-event-types";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import type {
  ComposerModelState,
  WorkspaceBudgetGovernance,
} from "./model-picker";
import type { McpServerSummary } from "./mcp-types";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import type { AgentOption } from "./agent-picker/agent-picker-types";
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";
import { ChatSelectionProvider } from "./agent-picker/chat-selection-context";
import { ChatSessionProvider, useChatSession } from "./session/session-store";
import { AgentAvatar } from "./agent-picker/agent-avatar";
import type { SessionSeed } from "./session/session-state";
import { ChatHeaderMobile } from "./chat-header-mobile";
import { ChatHeaderDesktop } from "./chat-header-desktop";
import {
  SessionSettingsDrawer,
  SessionSettingsRail,
  SessionSettingsSlideOver,
} from "./session/session-settings-host";
import { SessionSettings } from "./session/session-settings";
import { useSessionSettingsData } from "./session/use-session-settings-data";
import { useIsMobile, useMediaQuery } from "@/hooks/use-media-query";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { AgentGallery } from "./agent-picker/agent-gallery";
import {
  resolveDefaultRepoKey,
  resolveDefaultEnvId,
} from "./agent-picker/code-session-defaults";
import { resolveOptimisticDefaultAgent } from "./agent-picker/default-agent-optimistic";
import { deriveComposerPr } from "./composer-pr-status-chip";
import { SuggestedPromptChips } from "./suggested-prompt-chips";
import type { ConversationMessageSummary } from "@/lib/page-context/suggested-prompts";
import { ConversationExportMenu } from "./conversation-export-menu";
import { AgentActivityRail } from "./agent-activity-rail";
import { useLatestRef } from "@/lib/use-latest-ref";
import type { FieldDescriptor } from "@/lib/ask/fill-types";
import { interceptFormFillEvents } from "./intercept-form-fill";
import { ThinkingBubble } from "./thinking-bubble";
import { MessageFooter } from "./message-footer";
import { useToast } from "@/components/ui/toast";
import { PanelRight } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

/**
 * chat_ux_v2 desktop rail breakpoint — Tailwind's `xl` (1280px). An 800px
 * conversation column plus a 320px rail needs ~1280px of viewport, wider than
 * the legacy `lg` (1024px) rail breakpoint.
 */
const RAIL_BREAKPOINT_QUERY = "(min-width: 1280px)";

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

/** True for the turn-error codes that mean "the org's credit balance is empty". */
function isCreditsDepletedCode(code: string | undefined): boolean {
  return code === "insufficient_credits" || code === "credit_balance_empty";
}

/**
 * Read a human-readable error message from a failed stream response.
 *
 * The stream route returns `{ error: string }` JSON for the user-fixable
 * failure modes (e.g. a 422 when an attachment can't be resolved, or no
 * vision-capable model is configured). Surface THAT message instead of a bare
 * "HTTP 422", which strands the user with no next step. Returns `null` when the
 * body is missing, unparseable, or carries no non-empty `error` string, so the
 * caller can fall back to a status-based message.
 */
export async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const data: unknown = await res.clone().json();
    if (data && typeof data === "object" && "error" in data) {
      const err = (data as { error?: unknown }).error;
      if (typeof err === "string" && err.trim().length > 0) return err;
    }
  } catch {
    // Non-JSON or empty body — fall back to the status-line message.
  }
  return null;
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
  availableAgents,
  defaultAgentId,
  defaultRepoConnectionId,
  defaultRepoSlug,
  defaultEnvironmentId,
  setDefaultAgentAction,
  workspaceBudgetGovernance,
  agentId,
  conversationCodeBinding,
  pageContext,
  onFormFillStart,
  onFormFillEnd,
  onConversationCreated,
  reloadMessages,
  showFiles = true,
  chatUxV2 = false,
  walletBalanceCents = null,
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
  /** Selectable agents for the composer's agent picker. */
  availableAgents?: AgentOption[];
  /** The workspace user's default agent preference (agt_… public id), or null. */
  defaultAgentId?: string | null;
  /** Workspace user's default repo connection (con_…) for code-session prefill. */
  defaultRepoConnectionId?: string | null;
  /** Workspace user's default owner/repo slug for code-session prefill. */
  defaultRepoSlug?: string | null;
  /** Workspace user's default environment id for code-session prefill. */
  defaultEnvironmentId?: string | null;
  /** Persists the workspace default agent when the picker's star is toggled. */
  setDefaultAgentAction?: (
    agentId: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Workspace-level per-turn budget governance (OXA-2081). Null/omitted ⇒
   * no governance active for this workspace. */
  workspaceBudgetGovernance?: WorkspaceBudgetGovernance | null;
  /** Bound published agent's public id (Ask page ?agent=…). Seeds the initial
   * agent selection so the composer chip reflects the binding; the composer
   * then carries it in each stream request as `agentId`. Null ⇒ unbound. */
  agentId?: string | null;
  /**
   * The conversation's stored code binding (claimed on its first code turn).
   * When present the selection is forced to it and locked read-only — the
   * composer keeps sending the same bound `code` payload. Null ⇒ unbound. */
  conversationCodeBinding?: StoredCodeBinding | null;
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
  onFormFillEnd?: (
    result: import("@/lib/ask/fill-types").FormFillResult,
  ) => void;
  /**
   * Embedded mode (e.g. the floating in-app agent panel): the embedder owns the
   * conversation state instead of the RSC. When provided, ChatShellClient calls
   * this on the turn that creates the conversation (with the new ids) INSTEAD of
   * pinning the browser URL via router.replace — the floating panel has no route
   * of its own to pin.
   */
  onConversationCreated?: (
    conversationId: string,
    conversationPublicId: string,
  ) => void;
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
  /** chat_ux_v2 flag resolved server-side — mounts the unified session store. */
  chatUxV2?: boolean;
  /** Org credit balance in cents for the drawer's wallet footer row. */
  walletBalanceCents?: number | null;
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
    turnCostUsd,
    suggestedPrompts,
    consume,
    reset,
    hasBlockingApproval,
    hasBlockingConsent,
    signalApprovalResolved,
    signalConsentResolved,
  } = useToolStream();

  // Trimmed recent history for the no-LLM suggestion fallback: keeps the chips
  // conversation-aware on reload / before the first per-turn server suggestions
  // arrive. Server-generated `suggestedPrompts` take precedence in the chips.
  const conversationHistory = React.useMemo<ConversationMessageSummary[]>(
    () =>
      messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-6)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content.slice(0, 300),
        })),
    [messages],
  );

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
      description: isCreditsDepletedCode(turnError.code) ? (
        <>
          You&apos;re out of usage credits. To continue, click{" "}
          <Link
            href={`/${orgSlug}/billing/subscription`}
            className="font-semibold underline underline-offset-2"
          >
            here
          </Link>{" "}
          to purchase additional credits.
        </>
      ) : (
        turnError.message
      ),
    });
  }, [turnError, toast, orgSlug]);

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
  // Below-lg reflow of the right rail (trace + workspace context): the same
  // panels open in a bottom sheet — mobile feature parity per ADR-026.
  const [mobileRailOpen, setMobileRailOpen] = React.useState(false);
  // chat_ux_v2 mobile chrome: the session-settings full-screen drawer, opened
  // from the mobile header's center tap or the composer's cog button.
  const [sessionSettingsOpen, setSessionSettingsOpen] = React.useState(false);
  // Phone-width viewport (SSR-safe — false until after hydration). Gates the
  // v2 mobile header/FAB-removal/nav-autohide behavior below, alongside
  // `chatUxV2` — neither alone is sufficient (desktop v2 keeps the legacy
  // chrome; mobile without the flag keeps the legacy mobile chrome).
  const isMobileViewport = useIsMobile();
  const v2MobileChrome = chatUxV2 && isMobileViewport;

  // chat_ux_v2 desktop rail breakpoint: the rail needs real width (an 800px
  // conversation column + a 320px rail ≈ 1280px, Tailwind's `xl`) — wider than
  // the legacy `lg` (1024px) rail. `v2DesktopChrome` covers every non-mobile
  // viewport under the flag; `v2RailVisible`/`v2MidWidth` split it at `xl` so
  // the rail and the composer's session-settings cog are never both visible
  // (mid-width gets the cog + a slide-over instead of the rail — see the
  // composer/aside/slide-over wiring below).
  const isRailWidth = useMediaQuery(RAIL_BREAKPOINT_QUERY);
  const v2DesktopChrome = chatUxV2 && !isMobileViewport;
  const v2RailVisible = v2DesktopChrome && isRailWidth;
  const v2MidWidth = v2DesktopChrome && !isRailWidth;
  // The FAB/bottom-sheet Activity trigger's own breakpoint mirrors whichever
  // rail breakpoint applies (xl for v2, lg for legacy) so there's never a dead
  // zone where neither the rail nor the trigger can reach Progress/Files.
  const railHiddenBelowClass = chatUxV2 ? "xl:hidden" : "lg:hidden";
  const railVisibleAtClass = chatUxV2 ? "xl:block" : "lg:block";

  // Scrolls the rail's Session panel into view and focuses its first control —
  // wired to the v2 desktop header's click. Plain DOM (not component state):
  // the panel itself is SessionSettingsRail (session/session-settings-host.tsx,
  // owned by its own PR), so this reaches in from the outside rather than
  // adding an imperative-handle API to that shared component.
  const sessionPanelRef = React.useRef<HTMLDivElement>(null);
  const handleFocusSessionPanel = React.useCallback(() => {
    const el = sessionPanelRef.current;
    if (!el) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    const toggle = el.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
    requestAnimationFrame(() => {
      el.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )?.focus();
    });
  }, []);

  // v2 mobile: the chat screen owns its own slim header, so the app shell's
  // top bar (org/workspace switchers, wallet, bell) and the ConversationNav
  // mobile trigger hide via CSS keyed on this body attribute (see
  // globals.css). Set/cleared on mount so client-side navigation away from
  // the chat restores the shell chrome.
  React.useEffect(() => {
    if (!v2MobileChrome) return;
    document.body.dataset.chatUxV2Mobile = "1";
    return () => {
      delete document.body.dataset.chatUxV2Mobile;
    };
  }, [v2MobileChrome]);
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
          onConversationCreatedRef.current(
            result.conversationId,
            result.conversationPublicId,
          );
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
                try {
                  return JSON.parse(raw) as string[];
                } catch {
                  return [];
                }
              })(),
              // Per-turn dollar budget (OXA — turn-budget). The composer
              // always sets this (see message-composer.tsx budgetPayload) but
              // a malformed/missing value degrades to `null`, which the route
              // treats as "no per-turn override" and falls back to the user's
              // saved default (budget.policy.read).
              budget: (() => {
                const raw = formData.get("budget") as string | null;
                if (!raw) return null;
                try {
                  return JSON.parse(raw);
                } catch {
                  return null;
                }
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
              // Selected agent (OXA app-agent-selector). The composer sets this
              // to the chosen agent's publicId, or omits it for the default
              // (generic chat) agent — matching the stream route's BodySchema
              // `agentId: string | null`. A code agent (agentType==="code")
              // drives the server's code-mode branch (sandbox + code tools).
              agentId: (formData.get("agentId") as string) || null,
              // Pinned chat context (org/repo + environment). The composer only
              // sets this formData field when the user pinned a target AND is
              // not in code mode — otherwise null, matching the stream route's
              // BodySchema `pinnedContext: {...} | null`.
              pinnedContext: (() => {
                const raw = formData.get("pinnedContext") as string | null;
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
            // The stream route returns actionable JSON error bodies for the
            // failure modes a user can fix — notably a 422 when an attachment
            // can't be resolved ("remove and re-attach…") or no vision-capable
            // model is configured. Surfacing only "HTTP 422" strands the user
            // with no idea what to do, so prefer the server's `error` message
            // when present and fall back to the status line otherwise.
            const serverError = await readErrorMessage(res);
            const errMsg =
              serverError ??
              `Stream request failed (HTTP ${res.status}) — please try again.`;
            console.warn(
              "[chat]",
              `Stream request failed (HTTP ${res.status})`,
              serverError ?? "",
            );
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
            const msg = `${err.message || "Stream connection lost"} — please try again.`;
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

  // ── chat_ux_v2 mobile bottom-nav auto-hide ─────────────────────────────────
  // Dispatches `oxagen:mobile-nav-visibility` (consumed by MobileBottomBar) so
  // the bar tucks away while the user reads/scrolls the transcript or has the
  // on-screen keyboard open, and reappears once they scroll back up or blur
  // the composer — maximising the ≥70%-of-viewport conversation budget on a
  // phone without adding a second scroll listener anywhere else. Declared
  // ahead of `handleScroll` below so it can call these directly.
  const navHiddenRef = React.useRef(false);
  const dispatchNavVisibility = React.useCallback((hidden: boolean) => {
    if (navHiddenRef.current === hidden) return;
    navHiddenRef.current = hidden;
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("oxagen:mobile-nav-visibility", { detail: { hidden } }),
      );
    }
  }, []);
  // Only re-evaluates hide/show once scroll movement since the last decision
  // crosses the 8px threshold (in either direction) — a fixed per-event delta
  // would rarely fire since scroll events carry only a few px each.
  const scrollDecisionPointRef = React.useRef(0);
  const navRafRef = React.useRef<number | null>(null);
  const scheduleNavVisibilityCheck = React.useCallback(
    (scrollTop: number) => {
      if (navRafRef.current !== null) cancelAnimationFrame(navRafRef.current);
      navRafRef.current = requestAnimationFrame(() => {
        navRafRef.current = null;
        const delta = scrollTop - scrollDecisionPointRef.current;
        if (delta > 8) {
          dispatchNavVisibility(true);
          scrollDecisionPointRef.current = scrollTop;
        } else if (delta < -8) {
          dispatchNavVisibility(false);
          scrollDecisionPointRef.current = scrollTop;
        }
      });
    },
    [dispatchNavVisibility],
  );
  React.useEffect(() => {
    return () => {
      if (navRafRef.current !== null) cancelAnimationFrame(navRafRef.current);
    };
  }, []);
  // Show the bar again if v2-mobile chrome turns off (viewport resize to
  // desktop, or the flag itself) mid-hide, so it never gets stuck hidden.
  React.useEffect(() => {
    if (!v2MobileChrome) dispatchNavVisibility(false);
  }, [v2MobileChrome, dispatchNavVisibility]);
  // Keyboard-open heuristic: the composer's textarea is always `name="content"`
  // (both the legacy toolbar and the v2Mobile condensed row) — a document-level
  // focusin/focusout listener (they bubble, unlike focus/blur) detects it
  // without threading a new callback prop through MessageComposer.
  React.useEffect(() => {
    if (!v2MobileChrome) return;
    const isComposerTextarea = (el: EventTarget | null): boolean =>
      el instanceof HTMLTextAreaElement && el.name === "content";
    const onFocusIn = (e: FocusEvent) => {
      if (isComposerTextarea(e.target)) dispatchNavVisibility(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (isComposerTextarea(e.target)) dispatchNavVisibility(false);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [v2MobileChrome, dispatchNavVisibility]);

  // Detect when the user scrolls up mid-turn — disable auto-scroll so we
  // don't yank them back. Re-enable automatically once they're near the bottom.
  const v2MobileChromeRef = useLatestRef(v2MobileChrome);
  const handleScroll = React.useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // "Near the bottom" = within 80px (accounts for mobile rubber-banding
    // and 1px rounding differences across browsers).
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = fromBottom < 80;
    if (v2MobileChromeRef.current) scheduleNavVisibilityCheck(el.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- v2MobileChromeRef is a stable ref via useLatestRef; adding it would defeat the pattern
  }, [scheduleNavVisibilityCheck]);

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
    [
      wrappedResolveApproval,
      wrappedResolveConsent,
      resolvePlanAction,
      agentCapabilities,
    ],
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
            <ReasoningCard
              text={r.text}
              status={r.status}
              durationMs={r.durationMs}
            />
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
        // Only code-execute renders individually here; every other tool call is
        // merged into a ToolActivityGroup by the timeline builder below.
        if (tc.capability !== "execute_code") return null;
        const tone: TimelineTone =
          tc.status === "completed"
            ? "done"
            : tc.status === "failed"
              ? "failed"
              : "running";
        const active = tc.status === "pending" || tc.status === "running";
        const preview =
          (tc.inputPreview as Record<string, unknown> | null) ?? {};
        const language =
          typeof preview.language === "string" ? preview.language : "node";
        const code = typeof preview.code === "string" ? preview.code : "";
        const outputRecord =
          (tc.output as Record<string, unknown> | null) ?? {};
        const exitCode =
          typeof outputRecord.exitCode === "number"
            ? outputRecord.exitCode
            : undefined;
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
      case "text": {
        const seg = textSegments[key];
        if (!seg || !seg.text) return null;
        return {
          node: (
            <StreamingText
              text={seg.text}
              isStreaming={isStreaming}
              className="text-sm"
            />
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
              variant="write"
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

  // A groupable tool entry: a `tool:*` order key whose live tool call exists
  // and is NOT code-execute (that keeps its rich CodeExecuteCard). Returns the
  // live tool call, or null when the entry breaks a run.
  const groupableToolCall = (key: string) => {
    const sep = key.indexOf(":");
    if (key.slice(0, sep) !== "tool") return null;
    const tc = toolCalls[key.slice(sep + 1)];
    if (!tc || tc.capability === "execute_code") return null;
    return tc;
  };

  // Walk the ordered timeline, merging consecutive groupable tool calls into a
  // single compact ToolActivityGroup. Tool calls fire constantly and carry
  // little conversational signal, so collapsing a run into one quiet unit keeps
  // the thread readable. Any non-tool entry (text, reasoning, plan, approval,
  // code-execute…) breaks the run and renders through renderEntry as before.
  const timelineEntries: Array<{
    key: string;
    rendered: NonNullable<ReturnType<typeof renderEntry>>;
  }> = [];
  for (let i = 0; i < order.length; ) {
    if (groupableToolCall(order[i]!)) {
      const startKey = order[i]!;
      const runItems: ToolActivityItem[] = [];
      while (i < order.length) {
        const tc = groupableToolCall(order[i]!);
        if (!tc) break;
        runItems.push({
          toolCallId: tc.toolCallId,
          capability: tc.capability,
          inputPreview: tc.inputPreview,
          riskLevel: tc.riskLevel,
          status: tc.status,
          output: tc.output,
          stdout: tc.stdout,
          stderr: tc.stderr,
          errorReason: tc.errorReason,
          durationMs: tc.durationMs,
        });
        i++;
      }
      const anyActive = runItems.some(
        (it) => it.status === "pending" || it.status === "running",
      );
      timelineEntries.push({
        key: startKey,
        rendered: {
          // Rail stays calm: running while in-flight, else done — never failed.
          node: <ToolActivityGroup items={runItems} live={isStreaming} />,
          tone: anyActive ? "running" : "done",
          active: anyActive,
        },
      });
      continue;
    }
    const rendered = renderEntry(order[i]!);
    if (rendered) timelineEntries.push({ key: order[i]!, rendered });
    i++;
  }

  // The open PR for this conversation, derived from the latest completed
  // `edit_repo_file` / `open_pr` tool call. Feeds the composer's compact
  // "PR #123 ●" status chip (live CI on hover). Recomputed only when the tool
  // calls change — the walk is cheap, but memoising keeps the chip's prop
  // identity stable so its CI fetch effect doesn't re-run every render.
  const codeSessionPr = React.useMemo(
    () =>
      deriveComposerPr(
        order
          .filter((k) => k.startsWith("tool:"))
          .map((k) => toolCalls[k.slice("tool:".length)])
          .filter((tc): tc is NonNullable<typeof tc> => Boolean(tc))
          .map((tc) => ({
            capability: tc.capability,
            status: tc.status,
            inputPreview:
              (tc.inputPreview as Record<string, unknown> | null) ?? null,
            output: (tc.output as Record<string, unknown> | undefined) ?? null,
          })),
      ),
    [order, toolCalls],
  );

  // Agent-picker config: resolve the workspace user's saved coding defaults to
  // live selector values, and track the default agent optimistically so the
  // picker's star reflects a toggle instantly (reverting if the write fails).
  const defaultRepoKey = React.useMemo(
    () =>
      resolveDefaultRepoKey(
        availableRepos ?? [],
        defaultRepoConnectionId ?? null,
        defaultRepoSlug ?? null,
      ),
    [availableRepos, defaultRepoConnectionId, defaultRepoSlug],
  );
  const defaultEnvId = React.useMemo(
    () =>
      resolveDefaultEnvId(
        availableEnvironments ?? [],
        defaultEnvironmentId ?? null,
      ),
    [availableEnvironments, defaultEnvironmentId],
  );
  const [currentDefaultAgentId, setCurrentDefaultAgentId] = React.useState<
    string | null
  >(defaultAgentId ?? null);
  const handleSetDefaultAgent = React.useCallback(
    (id: string | null) => {
      setCurrentDefaultAgentId(id);
      if (!setDefaultAgentAction) return;
      void setDefaultAgentAction(id).then((res) => {
        // Revert target is the original server-provided value, not the
        // pre-toggle value (deliberate — see default-agent-optimistic.ts).
        setCurrentDefaultAgentId(
          resolveOptimisticDefaultAgent(res, id, defaultAgentId ?? null),
        );
      });
    },
    [setDefaultAgentAction, defaultAgentId],
  );

  // chat_ux_v2: the workspace-default seed for the unified session store —
  // also the "Reset to defaults" target and the cog-dot baseline.
  const sessionSeed = React.useMemo<SessionSeed>(
    () => ({
      defaultAgentId: currentDefaultAgentId,
      defaultRepoKey,
      defaultEnvId,
      textModel: initialModelState?.model ?? null,
      textTier: initialModelState?.tier ?? null,
      budgetUsd:
        initialModelState?.budgetEnabled && initialModelState.budgetUsd
          ? initialModelState.budgetUsd
          : null,
    }),
    [currentDefaultAgentId, defaultRepoKey, defaultEnvId, initialModelState],
  );

  const shell = (
    <ChatSelectionProvider
      agents={availableAgents ?? []}
      boundAgentId={agentId ?? null}
      workspaceDefaultAgentId={currentDefaultAgentId}
      defaultRepoKey={defaultRepoKey}
      defaultEnvId={defaultEnvId}
      conversationId={conversationId}
      workspaceSlug={workspaceSlug}
      isNewConversation={!conversationId}
      codeBinding={conversationCodeBinding ?? null}
    >
      <div className="flex h-full w-full gap-4">
        <div
          className={cn(
            "mx-auto flex h-full min-w-0 flex-1 flex-col gap-4",
            // chat_ux_v2's wider conversation column (800px vs the legacy
            // 768px) — applies at every viewport under the flag; harmless on
            // mobile where the column is already narrower than either cap.
            chatUxV2 ? "max-w-[800px]" : "max-w-3xl",
          )}
        >
          {/* chat_ux_v2 mobile chrome: the slim header (conversations / session
          summary / activity) replaces the desktop toolbar row below on a
          phone-width viewport. Mounted only inside ChatSessionProvider — see
          the chatUxV2 wrap at the bottom of this component — so its call to
          useChatSession() always resolves. */}
          {v2MobileChrome ? (
            <MobileSessionChrome
              agents={availableAgents ?? []}
              repos={availableRepos ?? []}
              environments={availableEnvironments ?? []}
              modelConfig={modelConfig}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              isStreaming={isStreaming}
              sessionSettingsOpen={sessionSettingsOpen}
              onSessionSettingsOpenChange={setSessionSettingsOpen}
              onOpenActivity={() => setMobileRailOpen(true)}
              walletBalanceCents={walletBalanceCents ?? null}
            />
          ) : null}

          {/* chat_ux_v2 desktop chrome: the compact conversation header —
          agent + subtitle, click-to-focus the rail's Session panel. Mounted
          only inside ChatSessionProvider, same reasoning as the mobile
          chrome above. Mutually exclusive with it (isMobileViewport gates
          one or the other). */}
          {v2DesktopChrome ? (
            <ChatHeaderDesktop
              agents={availableAgents ?? []}
              repos={availableRepos ?? []}
              environments={availableEnvironments ?? []}
              isStreaming={isStreaming}
              onFocusSessionPanel={handleFocusSessionPanel}
            />
          ) : null}

          {/* Toolbar row: export trigger (right-aligned). Hidden in the floating
          in-app panel (showFiles=false) — conversation files live on the full
          /ask page, in the side-panel's "Files" tab. Desktop-only in v2
          mobile chrome — the mobile header above replaces it. */}
          {showFiles && conversationPublicId && !v2MobileChrome ? (
            <div className="flex shrink-0 items-center justify-end gap-1">
              <ConversationExportMenu
                conversationId={conversationPublicId}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            </div>
          ) : null}

          {/* The wrapper (not the scroll container) is the anchor for the mobile
            Activity trigger below: an `absolute` child of the scroll container
            would scroll away with the messages, and the old `fixed` placement
            floated the pill over the composer's Send button on phones. */}
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollContainerRef}
              // `relative` is load-bearing: it makes this scroll container the
              // containing block for its absolutely-positioned descendants (e.g. the
              // `.sr-only` labels inside message-footer icon buttons). Without it
              // those abs elements anchor to the initial containing block, escape this
              // container's `overflow` clipping, and inflate the document height —
              // letting the whole page scroll past the composer on mobile and desktop.
              className="relative h-full overflow-y-auto pr-2"
              onScroll={handleScroll}
            >
              {messages.length === 0 && !hasLiveContent ? (
                <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-sm text-muted-foreground">
                  {/* v2 mobile with an agent already picked: a focused empty
                state — centered avatar + name + description; the starter
                prompts dock above the composer (below). Everywhere else the
                gallery hero renders as before. V2MobileEmptyState resolves
                the agent from the session store (it renders inside the
                provider) and falls back to the gallery when none is picked. */}
                  {v2MobileChrome ? (
                    <V2MobileEmptyState
                      agents={availableAgents ?? []}
                      gallery={
                        <AgentGallery
                          agents={availableAgents ?? []}
                          repos={availableRepos ?? []}
                          environments={availableEnvironments ?? []}
                          defaultRepoKey={defaultRepoKey}
                          defaultEnvId={defaultEnvId}
                          defaultAgentId={currentDefaultAgentId}
                          onSetDefaultAgent={
                            setDefaultAgentAction
                              ? handleSetDefaultAgent
                              : undefined
                          }
                          workspaceSlug={workspaceSlug}
                        />
                      }
                    />
                  ) : (
                    <AgentGallery
                      agents={availableAgents ?? []}
                      repos={availableRepos ?? []}
                      environments={availableEnvironments ?? []}
                      defaultRepoKey={defaultRepoKey}
                      defaultEnvId={defaultEnvId}
                      defaultAgentId={currentDefaultAgentId}
                      onSetDefaultAgent={
                        setDefaultAgentAction ? handleSetDefaultAgent : undefined
                      }
                      workspaceSlug={workspaceSlug}
                    />
                  )}
                  {(availableAgents?.length ?? 0) === 0 ? (
                    <div>
                      <p className="font-medium">Start a conversation.</p>
                      <p>Send a message below to begin.</p>
                    </div>
                  ) : null}
                  {/* Suggested chips inside the centered empty state — legacy
                only; v2 docks them directly above the composer instead. */}
                  {!chatUxV2 ? (
                    <SuggestedPromptChips
                      action={wrappedSendAction}
                      conversationId={conversationId}
                      parentMessageId={activeLeafMessageId}
                    />
                  ) : null}
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
                            // Anchor id for the coding-trace-panel rail's deep links
                            // (`#turn-entry-<key>`) — see chat-component-registry's
                            // sibling `coding-trace-panel.tsx`.
                            id={`turn-entry-${entry.key}`}
                            tone={entry.rendered.tone}
                            // The pulsing ring only animates an in-flight node while the
                            // turn is actually streaming.
                            isActive={entry.rendered.active && isStreaming}
                            isLast={
                              i === timelineEntries.length - 1 &&
                              turnUsage === undefined
                            }
                          >
                            {entry.rendered.node}
                          </TimelineItem>
                        ))}
                      </ActivityTimeline>
                      {/* Live cost estimate while a budgeted turn streams
                      (chat_ux_v2): "≈ $0.31" next to the in-progress
                      message, from per-step budget-tick events. */}
                      {chatUxV2 &&
                      isStreaming &&
                      turnCostUsd !== undefined ? (
                        <p
                          data-testid="live-cost-estimate"
                          aria-live="polite"
                          className="text-[11px] tabular-nums text-muted-foreground/80"
                        >
                          ≈ ${turnCostUsd.toFixed(2)}
                        </p>
                      ) : null}
                      {turnUsage !== undefined ? (
                        <div id="turn-result">
                          <MessageFooter
                            text={Object.values(textSegments)
                              .map((s) => s.text)
                              .join("")}
                            usage={turnUsage}
                            orgSlug={orgSlug}
                            workspaceSlug={workspaceSlug}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            {/* Below lg the trace rail lives in a bottom sheet (ADR-026 mobile
            parity); this floating trigger sits inside the message viewport —
            always above the composer, never over its Send/collapse controls.
            v2 mobile chrome reaches the same sheet through the header's
            Activity icon instead — the FAB would duplicate it. */}
            {showFiles && !v2MobileChrome ? (
              <button
                type="button"
                data-testid="chat-mobile-rail-trigger"
                aria-haspopup="dialog"
                aria-expanded={mobileRailOpen}
                onClick={() => setMobileRailOpen(true)}
                className={cn(
                  "absolute bottom-3 right-3 z-20 flex h-11 items-center gap-1.5 rounded-full border border-border/60",
                  "bg-background/95 px-4 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur",
                  railHiddenBelowClass,
                  "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <PanelRight className="size-4" aria-hidden="true" />
                Activity
              </button>
            ) : null}
          </div>
          {/* Suggested prompt chips. Legacy: shown above the composer once
          there are messages (the empty state renders its own centered set).
          v2 INVERTS this: suggestions exist ONLY in the empty state, docked
          directly above the composer, left-aligned, at most 3, sentence case
          — and disappear permanently after the first user message. */}
          {!chatUxV2 && (messages.length > 0 || hasLiveContent) ? (
            <SuggestedPromptChips
              action={wrappedSendAction}
              conversationId={conversationId}
              parentMessageId={activeLeafMessageId}
              suggestions={suggestedPrompts}
              conversationHistory={conversationHistory}
              className="justify-center"
            />
          ) : null}
          {chatUxV2 && messages.length === 0 && !hasLiveContent ? (
            <SuggestedPromptChips
              action={wrappedSendAction}
              conversationId={conversationId}
              parentMessageId={activeLeafMessageId}
              sentenceCase
              maxPrompts={3}
              stacked={v2MobileChrome}
              align={v2MobileChrome ? "center" : "start"}
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
              {streamError}
            </div>
          ) : null}

          {/* v2 mobile chrome: reserve the home-indicator safe area on the
          composer's own wrapper — once the bottom nav auto-hides (see the
          scroll/focus effects above) the composer can end up flush with the
          bottom edge of the screen. */}
          <div
            className={
              v2MobileChrome ? "pb-[env(safe-area-inset-bottom)]" : undefined
            }
          >
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
              availableAgents={availableAgents}
              defaultRepoKey={defaultRepoKey}
              defaultEnvId={defaultEnvId}
              defaultAgentId={currentDefaultAgentId}
              onSetDefaultAgent={
                setDefaultAgentAction ? handleSetDefaultAgent : undefined
              }
              workspaceBudgetGovernance={workspaceBudgetGovernance}
              walletBalanceUsd={
                walletBalanceCents != null ? walletBalanceCents / 100 : null
              }
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              codeSessionPr={codeSessionPr}
              onOpenSessionSettings={
                v2MobileChrome || v2MidWidth
                  ? () => setSessionSettingsOpen(true)
                  : undefined
              }
              showComposerCog={v2MidWidth}
            />
          </div>
        </div>
        {/* Right rail: legacy three-card activity rail (Progress / Context /
          Outputs); chat_ux_v2 desktop swaps Context for the writable Session
          panel (`sessionPanelSlot`). Hidden in the floating in-app panel
          (showFiles=false, same gate the toolbar's export trigger uses) and on
          narrow viewports — the rail needs real width to be legible; below
          the breakpoint it reflows into the bottom sheet below. */}
        {showFiles ? (
          <aside
            className={cn(
              "hidden shrink-0 overflow-y-auto py-1",
              chatUxV2 ? "w-80" : "w-72",
              railVisibleAtClass,
            )}
          >
            <AgentActivityRail
              order={order}
              plans={plans}
              toolCalls={toolCalls}
              activeFanouts={activeFanouts}
              turnUsage={turnUsage}
              isStreaming={isStreaming}
              conversationPublicId={conversationPublicId}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              codeSessionPr={codeSessionPr}
              availableRepos={availableRepos}
              availableEnvironments={availableEnvironments}
              conversationCodeBinding={conversationCodeBinding ?? null}
              v2={chatUxV2}
              sessionPanelSlot={
                // Only mount the (real, non-trivial) Session panel once the
                // rail is ACTUALLY visible — the aside itself stays mounted
                // at every viewport (CSS-hidden below the breakpoint, same as
                // legacy), but there's no reason to run the panel's branch
                // fetch or render its pickers behind `display:none` on
                // mobile/mid-width, where the drawer/slide-over owns settings
                // instead.
                v2RailVisible ? (
                  <div ref={sessionPanelRef}>
                    <DesktopSessionPanel
                      agents={availableAgents ?? []}
                      repos={availableRepos ?? []}
                      environments={availableEnvironments ?? []}
                      modelConfig={modelConfig}
                      orgSlug={orgSlug}
                      workspaceSlug={workspaceSlug}
                      walletBalanceCents={walletBalanceCents ?? null}
                    />
                  </div>
                ) : undefined
              }
            />
          </aside>
        ) : null}

        {/* Below the rail breakpoint the rail reflows into a bottom sheet
          (ADR-026 mobile parity); its floating trigger lives inside the
          message viewport above (anchored to the scroll-area wrapper, so it
          can't cover the composer). NO sessionPanelSlot here even under
          chatUxV2 — on mobile the drawer owns settings, and at mid-width the
          slide-over does; this sheet is Progress/Files only. */}
        {showFiles ? (
          <div className={railHiddenBelowClass}>
            <Sheet open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
              <SheetPopup
                side="bottom"
                className="flex max-h-[85vh] flex-col gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
              >
                <SheetHeader className="border-b px-4 py-3 text-left">
                  <SheetTitle>Activity</SheetTitle>
                  <SheetDescription className="sr-only">
                    Turn trace and workspace context for this conversation
                  </SheetDescription>
                </SheetHeader>
                <div
                  className="overflow-y-auto p-3"
                  data-testid="chat-mobile-rail-sheet"
                >
                  <AgentActivityRail
                    order={order}
                    plans={plans}
                    toolCalls={toolCalls}
                    activeFanouts={activeFanouts}
                    turnUsage={turnUsage}
                    isStreaming={isStreaming}
                    conversationPublicId={conversationPublicId}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                    codeSessionPr={codeSessionPr}
                    availableRepos={availableRepos}
                    availableEnvironments={availableEnvironments}
                    conversationCodeBinding={conversationCodeBinding ?? null}
                    v2={chatUxV2}
                  />
                </div>
              </SheetPopup>
            </Sheet>
          </div>
        ) : null}
      </div>
      {/* chat_ux_v2 mid-width (md–xl): the rail is hidden, so Session settings
          moves to a right slide-over — controlled by the SAME sessionSettingsOpen
          state the mobile drawer uses (they're mutually exclusive by viewport). */}
      {v2MidWidth ? (
        <DesktopSessionSlideOver
          open={sessionSettingsOpen}
          onOpenChange={setSessionSettingsOpen}
          agents={availableAgents ?? []}
          repos={availableRepos ?? []}
          environments={availableEnvironments ?? []}
          modelConfig={modelConfig}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          walletBalanceCents={walletBalanceCents ?? null}
        />
      ) : null}
    </ChatSelectionProvider>
  );

  if (!chatUxV2) return shell;
  // chat_ux_v2: the unified session store wraps the whole shell. The legacy
  // stores above keep rendering, but every read/write is bridged onto this
  // one store (see session/session-bridges.tsx), so the run payload and every
  // display agree by construction.
  return (
    <ChatSessionProvider
      workspaceSlug={workspaceSlug}
      conversationId={conversationId}
      boundAgentId={agentId ?? null}
      isNewConversation={!conversationId}
      hasMessages={messages.length > 0 || isStreaming}
      seed={sessionSeed}
      codeBinding={conversationCodeBinding ?? null}
    >
      {shell}
    </ChatSessionProvider>
  );
}

/**
 * V2MobileEmptyState — the focused mobile empty state once an agent is
 * picked: centered avatar + name + one-line description (the starter prompts
 * dock above the composer, outside this block). Falls back to the provided
 * gallery while no agent is selected. Rendered INSIDE ChatSessionProvider so
 * it can resolve the picked agent from the session store.
 */
function V2MobileEmptyState({
  agents,
  gallery,
}: {
  agents: AgentOption[];
  gallery: React.ReactNode;
}) {
  const { state } = useChatSession();
  const agent = state.agentId
    ? (agents.find((a) => a.agentId === state.agentId) ?? null)
    : null;
  if (!agent) return <>{gallery}</>;
  const description = agent.summary ?? agent.description;
  return (
    <div
      className="flex flex-col items-center gap-2 px-6"
      data-testid="v2-mobile-empty-state"
    >
      <AgentAvatar
        avatarUrl={agent.avatarUrl}
        name={agent.name}
        slug={agent.slug}
        size="lg"
        shape="square"
      />
      <p className="text-base font-semibold text-foreground">{agent.name}</p>
      {description ? (
        <p className="line-clamp-2 text-sm">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * MobileSessionChrome — the v2 mobile header + session-settings drawer,
 * rendered as a child of `ChatSessionProvider` (so `useChatSession()` always
 * resolves) whenever `v2MobileChrome` is true. Branch-list fetch/caching for
 * the drawer's Code section is shared with the desktop rail panel and
 * mid-width slide-over via `useSessionSettingsData` (see
 * `session/use-session-settings-data.ts`).
 */
function MobileSessionChrome({
  agents,
  repos,
  environments,
  modelConfig,
  orgSlug,
  workspaceSlug,
  isStreaming,
  sessionSettingsOpen,
  onSessionSettingsOpenChange,
  onOpenActivity,
  walletBalanceCents,
}: {
  agents: AgentOption[];
  repos: RepoOption[];
  environments: EnvironmentOption[];
  modelConfig: ResolvedTierCatalog;
  orgSlug: string;
  workspaceSlug: string;
  isStreaming: boolean;
  sessionSettingsOpen: boolean;
  onSessionSettingsOpenChange: (open: boolean) => void;
  onOpenActivity: () => void;
  walletBalanceCents: number | null;
}) {
  const router = useRouter();
  const { branches, branchesLoading, onLoadBranches, defaultBranch } =
    useSessionSettingsData({ repos, orgSlug, workspaceSlug });

  return (
    <>
      <ChatHeaderMobile
        agents={agents}
        repos={repos}
        environments={environments}
        isStreaming={isStreaming}
        onOpenSettings={() => onSessionSettingsOpenChange(true)}
        onOpenActivity={onOpenActivity}
        onOpenConversations={() =>
          window.dispatchEvent(new CustomEvent("oxagen:open-conversations"))
        }
        notificationsSlot={<NotificationsBell />}
      />
      <SessionSettingsDrawer
        open={sessionSettingsOpen}
        onOpenChange={onSessionSettingsOpenChange}
      >
        <SessionSettings
          variant="drawer"
          agents={agents}
          repos={repos}
          environments={environments}
          modelConfig={modelConfig}
          branches={branches}
          branchesLoading={branchesLoading}
          onLoadBranches={onLoadBranches}
          defaultBranch={defaultBranch}
          walletBalanceUsd={
            walletBalanceCents !== null ? walletBalanceCents / 100 : null
          }
          onOpenWallet={() => {
            onSessionSettingsOpenChange(false);
            router.push(`/${orgSlug}/billing`);
          }}
        />
      </SessionSettingsDrawer>
    </>
  );
}

/**
 * DesktopSessionPanel — the chat_ux_v2 desktop rail's writable Session panel:
 * `SessionSettingsRail` chrome wrapping `SessionSettings variant="rail"`,
 * rendered as the rail's `sessionPanelSlot` (replacing the read-only legacy
 * Context card). Same branch-fetch hook as the mobile drawer.
 */
function DesktopSessionPanel({
  agents,
  repos,
  environments,
  modelConfig,
  orgSlug,
  workspaceSlug,
  walletBalanceCents,
}: {
  agents: AgentOption[];
  repos: RepoOption[];
  environments: EnvironmentOption[];
  modelConfig: ResolvedTierCatalog;
  orgSlug: string;
  workspaceSlug: string;
  walletBalanceCents: number | null;
}) {
  const router = useRouter();
  const { branches, branchesLoading, onLoadBranches, defaultBranch } =
    useSessionSettingsData({ repos, orgSlug, workspaceSlug });

  return (
    <SessionSettingsRail>
      <SessionSettings
        variant="rail"
        agents={agents}
        repos={repos}
        environments={environments}
        modelConfig={modelConfig}
        branches={branches}
        branchesLoading={branchesLoading}
        onLoadBranches={onLoadBranches}
        defaultBranch={defaultBranch}
        walletBalanceUsd={
          walletBalanceCents !== null ? walletBalanceCents / 100 : null
        }
        onOpenWallet={() => router.push(`/${orgSlug}/billing`)}
      />
    </SessionSettingsRail>
  );
}

/**
 * DesktopSessionSlideOver — chat_ux_v2 mid-width (md–xl, rail hidden): the
 * same Session settings surface as the rail panel, in a right slide-over
 * reached via the composer's cog instead of always-visible rail real estate.
 */
function DesktopSessionSlideOver({
  open,
  onOpenChange,
  agents,
  repos,
  environments,
  modelConfig,
  orgSlug,
  workspaceSlug,
  walletBalanceCents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentOption[];
  repos: RepoOption[];
  environments: EnvironmentOption[];
  modelConfig: ResolvedTierCatalog;
  orgSlug: string;
  workspaceSlug: string;
  walletBalanceCents: number | null;
}) {
  const router = useRouter();
  const { branches, branchesLoading, onLoadBranches, defaultBranch } =
    useSessionSettingsData({ repos, orgSlug, workspaceSlug });

  return (
    <SessionSettingsSlideOver open={open} onOpenChange={onOpenChange}>
      <SessionSettings
        variant="slide-over"
        agents={agents}
        repos={repos}
        environments={environments}
        modelConfig={modelConfig}
        branches={branches}
        branchesLoading={branchesLoading}
        onLoadBranches={onLoadBranches}
        defaultBranch={defaultBranch}
        walletBalanceUsd={
          walletBalanceCents !== null ? walletBalanceCents / 100 : null
        }
        onOpenWallet={() => {
          onOpenChange(false);
          router.push(`/${orgSlug}/billing`);
        }}
      />
    </SessionSettingsSlideOver>
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
        <span className="text-info">· working</span>
      ) : null}
    </div>
  );
}

// Shared loading skeleton for a lazily-rendered registry component.
function ComponentSkeleton() {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card px-4 py-3",
        "animate-pulse space-y-2",
      )}
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
