"use client";
import * as React from "react";
import {
  Brain,
  ChevronDown,
  ChevronUp,
  ImageIcon,
  Paperclip,
  Plus,
  Send,
  SlidersHorizontal,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-media-query";
import { supportsReasoning, getModel } from "@oxagen/ai/catalog";
import type { ResolvedTierCatalog, EffortLevel } from "@oxagen/ai/catalog";
import {
  ModelPicker,
  defaultModelState,
  applyWorkspaceBudgetGovernance,
  type ComposerModelState,
  type WorkspaceBudgetGovernance,
} from "./model-picker";
import type { McpServerSummary } from "./mcp-types";
import { McpServerPicker } from "./mcp-server-picker";
import { BudgetControl } from "./budget-control";
import { useSessionModelState } from "./session/session-bridges";
import { FOCUS_COMPOSER_EVENT } from "./agent-picker/focus-composer-event";
import { useChatSessionContext } from "./session/session-store";
import { sessionSelectionIssues } from "./session/session-state";
import { ComposerContextControls } from "./composer-context-controls";
import type { ComposerPrStatus } from "./composer-pr-status-chip";
import { SlashCommandMenu } from "./slash-command-menu";
// Import from the client-safe subpath, NOT the @oxagen/ai barrel: the barrel
// pulls telemetry/clickhouse/opentelemetry (async_hooks) into the client bundle
// and breaks the build. slash-commands.ts is dependency-free.
import {
  matchSlashCommands,
  type SlashCommand,
} from "@oxagen/ai/slash-commands";
// Same client-safe-subpath rule as slash-commands: mentions.ts is dependency-free.
import {
  applyMentionPlaceholders,
  mentionPlaceholder,
  matchMentionTypes,
  type MentionTypeInfo,
  type PendingMention,
} from "@oxagen/ai/mentions";
import { MentionMenu } from "./mentions/mention-menu";
import { MentionChip } from "./mentions/mention-chip";
import { useMentionSearch } from "./mentions/use-mention-search";
import type { MentionSearchResult } from "./mentions/mention-meta";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import type { AgentOption } from "./agent-picker/agent-picker-types";
import { AgentContextChip } from "./agent-picker/agent-context-chip";
import { useComposerSelectionState } from "./agent-picker/chat-selection-context";
import {
  pinStorageKey,
  readStoredPins,
  writeStoredPins,
  buildPinnedContext,
  DRAFT_PREFIX,
} from "./pinned-context";
import { MessageQueue } from "./message-queue";
import {
  AttachmentChip,
  hasInFlightUploads,
  type PendingAttachment,
} from "./attachment-chip";
import { extractVideoFrames } from "./extract-video-frames";
import { AttachTray } from "./attach-tray";
import { AttachPopover } from "./attach-popover";

/** Images attach directly; videos attach too (Phase 2) — a video-capable model
 * receives the video file, otherwise the server falls back to keyframes the
 * composer extracts client-side (see extract-video-frames.ts). */
const ATTACHMENT_ACCEPT = "image/*,video/*";
/** Bounds a single turn's VISIBLE attachment count. Hidden video keyframes
 * don't count here; the total serialized set (visible + keyframes) is bounded
 * by the stream route's `attachments` array cap (BodySchema `.max(16)`). */
const MAX_ATTACHMENTS = 8;
/** Keyframes sampled per attached video for the vision-only fallback path.
 * Kept low so a video + its frames stays well under the server's 16-attachment
 * cap even with a couple of videos in one turn. */
const VIDEO_KEYFRAME_COUNT = 3;

/**
 * Mirrors `ASSET_LIMITS` from packages/storage/src/assets.ts for the three
 * kinds this composer ever submits. Duplicated rather than imported: that
 * package's barrel (`@oxagen/storage`) re-exports the Vercel Blob adapter and
 * pulls in `node:crypto`, which breaks the client bundle — the same
 * client-bundle-safety rule already documented above for `@oxagen/ai`'s
 * dependency-free `slash-commands`/`mentions` subpaths. A stale value here
 * only makes the client-side pre-check slightly off; the server re-validates
 * every upload regardless, so this is never a security boundary.
 */
const ATTACHMENT_SIZE_LIMITS: Record<"image" | "video" | "document", number> = {
  image: 5 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};

/** A file paired with the server upload kind it will be sent as — the shape
 * `queueAttachmentBatch`, `addFiles`, and `addClassifiedFiles` all share. */
type ClassifiedFile = { file: File; kind: "image" | "video" | "document" };

/** The serializable subset of an uploaded attachment sent to the server —
 * mirrors `conversationAssetItem` minus fields the composer never needs, plus
 * the video↔keyframe link (Phase 2). */
export interface UploadedAttachmentMeta {
  publicId: string;
  kind: string;
  name: string;
  mimeType: string;
  url: string;
  /** Set on a keyframe image to the server publicId of its source video. */
  keyframeForVideo?: string;
}

/** A pending @-mention plus the picked search row's display extras, so the
 * composer's chip strip can show description/properties without refetching. */
interface ComposerMention extends PendingMention {
  properties: Record<string, unknown>;
  description: string | null;
}

function toUploadedMeta(
  attachments: PendingAttachment[],
): UploadedAttachmentMeta[] {
  // Map each video attachment's LOCAL id → its server publicId, so a keyframe
  // (which references the video by local id, created before the video finished
  // uploading) can be linked to the real publicId at submit time.
  const videoPublicIdByLocalId = new Map<string, string>();
  for (const a of attachments) {
    if (a.status === "uploaded" && a.kind === "video" && a.publicId) {
      videoPublicIdByLocalId.set(a.id, a.publicId);
    }
  }
  return (
    attachments
      .filter(
        (
          a,
        ): a is PendingAttachment &
          Required<
            Pick<
              PendingAttachment,
              "publicId" | "kind" | "mimeType" | "url" | "name"
            >
          > =>
          a.status === "uploaded" &&
          a.publicId !== undefined &&
          a.kind !== undefined &&
          a.mimeType !== undefined &&
          a.url !== undefined &&
          a.name !== undefined,
      )
      // Drop an orphan keyframe whose source video failed to upload — sending it
      // as a plain image would misrepresent it as a user-picked picture.
      .filter(
        (a) =>
          a.keyframeForVideoLocalId === undefined ||
          videoPublicIdByLocalId.has(a.keyframeForVideoLocalId),
      )
      .map((a) => ({
        publicId: a.publicId,
        kind: a.kind,
        name: a.name,
        mimeType: a.mimeType,
        url: a.url,
        ...(a.keyframeForVideoLocalId
          ? {
              keyframeForVideo: videoPublicIdByLocalId.get(
                a.keyframeForVideoLocalId,
              )!,
            }
          : {}),
      }))
  );
}

/** Build the per-turn budget wire payload from a model-state snapshot. Shared
 * by buildFormData (live submit) and dispatchQueued (queued-message drain) so
 * the two send paths can never drift on the budget shape. */
function budgetPayload(modelSnapshot: ComposerModelState) {
  return {
    enabled: modelSnapshot.budgetEnabled,
    limitUsd: modelSnapshot.budgetEnabled ? modelSnapshot.budgetUsd : null,
    mode: modelSnapshot.budgetMode,
    graceOveragePct: modelSnapshot.budgetGracePct,
  };
}

/** The wire shape of the stream route's `code` BodySchema field. */
export interface CodeModePayload {
  connectionId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  environmentId: string;
  /** Human label for the environment, so the agent context shows the name, not
   * the opaque `env_…` id. Null when the id couldn't be resolved to an option. */
  environmentName: string | null;
  sandboxSessionId: string | null;
}

/**
 * Build the `code` wire payload from the composer's code-mode state, or
 * `null` when code mode is off or a required selection is missing (the send
 * gate keeps the latter from ever reaching submit, but this stays defensive).
 * `sandboxSessionId` is always `null` here — reserved for future session reuse.
 */
function codePayload(
  codeMode: boolean,
  repo: RepoOption | null,
  environment: EnvironmentOption | null,
): CodeModePayload | null {
  if (!codeMode || !repo || !environment) return null;
  return {
    connectionId: repo.connectionId,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    environmentId: environment.id,
    environmentName: environment.name,
    sandboxSessionId: null,
  };
}

export interface ComposerAction {
  (
    formData: FormData,
  ): Promise<{
    ok: boolean;
    error?: string;
    // sendMessageAction returns these on success so the caller can start the
    // chat stream with the persisted conversation id and the just-created
    // user-message id, and pin the browser URL to the conversation's public id
    // when the turn created it. Optional because other composer actions (e.g.
    // the org-shell quick-send) don't produce them.
    conversationId?: string;
    conversationPublicId?: string;
    userMessageId?: string;
  }>;
}

/** A queued message waiting to be sent once the current stream completes. */
interface QueuedMessage {
  /** Stable identity for the React key + edit/remove/reorder/send-now ops. */
  id: string;
  /** The text content typed by the user while a stream was in flight. */
  content: string;
  /** The model state at the time the user hit submit. */
  modelState: ComposerModelState;
  /** Attachments that had finished uploading at the time of submit. */
  attachments: UploadedAttachmentMeta[];
}

/** Monotonic counter for queued-message ids (stable, collision-free per mount). */
let queueIdCounter = 0;
function nextQueueId(): string {
  queueIdCounter += 1;
  return `q-${queueIdCounter}`;
}

/**
 * localStorage key for the collapsed-composer preference. Collapsing the
 * composer maximises vertical chat scroll height (especially on phones), so
 * the choice persists across visits.
 */
export const COMPOSER_COLLAPSED_STORAGE_KEY = "oxagen.chat.composerCollapsed";

function persistComposerCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(
      COMPOSER_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
  } catch {
    // Private mode / storage quota — the preference just doesn't persist.
  }
}

/**
 * CondensedComposerRow — the [plus] [textarea] [cog?] [send] row shared by
 * v2Mobile (chat_ux_v2 + phone width, cog always shown) and v2Desktop
 * (chat_ux_v2 + non-mobile, cog shown only when the caller passes
 * `showCog: true` at mid-width). Extracted so the two condensed surfaces
 * can't drift on markup/behavior — only the cog's visibility differs, driven
 * entirely by the `showCog` prop.
 */
function CondensedComposerRow({
  testId,
  canAttach,
  pending,
  disabled,
  attachmentCount,
  onAttachClick,
  attachTrigger,
  placeholder,
  onKeyDown,
  onChange,
  onBlur,
  onPaste,
  showCog,
  cogAriaLabel,
  cogDotClass,
  onOpenSessionSettings,
  sendDisabled,
  sendAriaLabel,
}: {
  testId: string;
  canAttach: boolean;
  pending: boolean;
  disabled: boolean;
  attachmentCount: number;
  onAttachClick: () => void;
  /**
   * v2Desktop only: replaces the default plus Button entirely with a
   * self-contained trigger (AttachPopover owns its own button + popup) —
   * `onAttachClick` is then never invoked. v2Mobile omits this and opens the
   * AttachTray bottom sheet from `onAttachClick` instead (a popover is
   * banned on touch surfaces per the v2 design rules).
   */
  attachTrigger?: React.ReactNode;
  placeholder: string;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  showCog: boolean;
  cogAriaLabel: string;
  cogDotClass: string | null;
  onOpenSessionSettings?: () => void;
  sendDisabled: boolean;
  sendAriaLabel: string;
}) {
  return (
    <div className="flex items-center gap-1" data-testid={testId}>
      {canAttach ? (
        attachTrigger ?? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Add attachment"
            disabled={pending || disabled || attachmentCount >= MAX_ATTACHMENTS}
            onClick={onAttachClick}
            className="h-11 w-11 shrink-0 p-0"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )
      ) : null}
      {/* No `required`: the spec bans the native browser validation tooltip —
        an empty message simply leaves send disabled. */}
      <Textarea
        name="content"
        placeholder={placeholder}
        rows={1}
        disabled={pending || disabled}
        onKeyDown={onKeyDown}
        onChange={onChange}
        onBlur={onBlur}
        onPaste={onPaste}
        className="min-h-0 flex-1 resize-none border-none bg-transparent py-2 shadow-none focus-visible:ring-0"
      />
      {showCog ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={cogAriaLabel}
          onClick={onOpenSessionSettings}
          className="relative h-11 w-11 shrink-0 p-0"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {cogDotClass ? (
            <span
              aria-hidden="true"
              data-testid="composer-cog-dot"
              className={cn("absolute right-2 top-2 size-1.5 rounded-full", cogDotClass)}
            />
          ) : null}
        </Button>
      ) : null}
      <Button
        type="submit"
        disabled={sendDisabled}
        size="sm"
        aria-label={sendAriaLabel}
        className="h-11 w-11 shrink-0 p-0"
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function MessageComposer({
  conversationId,
  parentMessageId,
  action,
  disabled = false,
  disabledReason,
  modelConfig,
  enterToSubmit = false,
  pendingPromptBehavior = "queue",
  isStreaming = false,
  onInterrupt,
  initialModelState,
  availableMcpServers,
  availableRepos,
  availableEnvironments,
  availableAgents,
  defaultRepoKey,
  defaultEnvId,
  defaultAgentId,
  onSetDefaultAgent,
  workspaceBudgetGovernance,
  walletBalanceUsd = null,
  onInputHasContentChange,
  orgSlug,
  workspaceSlug,
  codeSessionPr,
  onOpenSessionSettings,
  showComposerCog = false,
}: {
  conversationId: string | null;
  parentMessageId: string | null;
  action: ComposerAction;
  disabled?: boolean;
  disabledReason?: string;
  modelConfig: ResolvedTierCatalog;
  /**
   * Slug context for the attachment upload endpoint (`/api/v1/upload/attachment`
   * requires an org+workspace scope for its IDOR/membership guard). Optional —
   * omitting either hides the paperclip/paste/drop attach affordance so a
   * composer instance with no tenant context degrades to text-only instead of
   * uploading with a malformed request.
   */
  orgSlug?: string;
  workspaceSlug?: string;
  /** When true: Enter submits, Shift+Enter inserts a newline. Default false. */
  enterToSubmit?: boolean;
  /** What to do when user submits while a stream is in flight. Default 'queue'. */
  pendingPromptBehavior?: "queue" | "interrupt";
  /** Whether an AI stream is currently active. Used to drive queue/interrupt. */
  isStreaming?: boolean;
  /** Called to abort the current in-flight stream (interrupt mode only). */
  onInterrupt?: () => void;
  /** Initial model state seeded from effective server-side defaults. */
  initialModelState?: ComposerModelState;
  /** Available MCP servers for the per-turn activation picker. */
  availableMcpServers?: McpServerSummary[];
  /** GitHub repos usable as the code-mode target (see _shared/code-mode-data.ts). */
  availableRepos?: RepoOption[];
  /** Workspace environments usable as the code-mode target. */
  availableEnvironments?: EnvironmentOption[];
  /** Selectable agents for the agent picker; a code agent governs code mode. */
  availableAgents?: AgentOption[];
  /** Prefill for a code agent's repo session (a `RepoOption.key`); from workspace prefs. */
  defaultRepoKey?: string | null;
  /** Prefill for a code agent's environment session; from workspace prefs. */
  defaultEnvId?: string | null;
  /** The workspace user's current default agent (agt_… public id), or null. */
  defaultAgentId?: string | null;
  /** Toggle the workspace default agent from the picker's star. Omitted ⇒ star hidden. */
  onSetDefaultAgent?: (agentId: string | null) => void;
  /**
   * Workspace-level per-turn budget governance (OXA-2081), resolved
   * server-side via `workspace.budget.policy.read`. Null/omitted ⇒ no
   * governance — the composer behaves exactly as before this feature.
   */
  workspaceBudgetGovernance?: WorkspaceBudgetGovernance | null;
  /**
   * Org wallet balance in USD for the v2 wallet gate: when a per-turn cap is
   * set higher than the balance, send disables with inline copy. Null/omitted
   * ⇒ no gate (balance unknown never blocks sending).
   */
  walletBalanceUsd?: number | null;
  /**
   * Called whenever the textarea transitions between empty and non-empty.
   * `true`  → user has typed content (hide suggested prompts).
   * `false` → input is empty / cleared (show suggested prompts).
   */
  onInputHasContentChange?: (hasContent: boolean) => void;
  /**
   * The pull request the coding agent has opened for this conversation, if any.
   * Rendered as a compact "PR #123 ●" chip in the composer footer whose status
   * circle reflects live CI for the PR head (hover → per-check timing + tally).
   * Null/omitted ⇒ no chip. Derived by the parent from the latest
   * `agent.repo.edit` / `repo.pr.open` tool result in the conversation.
   */
  codeSessionPr?: ComposerPrStatus | null;
  /**
   * chat_ux_v2 condensed row only: opens the session-settings surface from the
   * cog button. Always used by v2Mobile (which always shows a cog — there is
   * no rail there); on v2Desktop only when `showComposerCog` is true.
   */
  onOpenSessionSettings?: () => void;
  /**
   * chat_ux_v2 desktop only: shows the condensed row's cog button at
   * mid-width viewports where the rail is hidden (chat-shell-client.tsx owns
   * the breakpoint check). At no width may both the rail and this cog be
   * visible. Ignored on v2Mobile, which always shows the cog, and has no
   * effect outside v2Desktop.
   */
  showComposerCog?: boolean;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  // Seed once at mount, applying any workspace budget governance (OXA-2081)
  // on top of the server-resolved default — a "default" governance pre-fills
  // an unset control, a "ceiling" clamps it. Governance is resolved
  // server-side and doesn't change over the composer's lifetime. When the
  // chat_ux_v2 session provider wraps the tree, model/effort/budget/generate
  // live in the unified session store (see session-bridges.tsx); otherwise
  // this behaves as the plain local state it always was.
  const seededInitialModelState = React.useMemo(
    () =>
      applyWorkspaceBudgetGovernance(
        initialModelState ?? defaultModelState,
        workspaceBudgetGovernance ?? null,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once; both inputs are server-resolved and stable for the mount
    [],
  );
  const [model, setModel] = useSessionModelState(
    seededInitialModelState,
    workspaceBudgetGovernance ?? null,
  );
  const [activeServerIds, setActiveServerIds] = React.useState<Set<string>>(
    new Set(),
  );

  // ── Code mode (OXA app-code-mode) ─────────────────────────────────────────
  // Agent + code-session (repo/env) selection lives in a shared store so the
  // composer chip and the empty-state gallery drive the SAME selection. Without
  // a provider (a bare composer in tests) this transparently falls back to a
  // self-contained local store, so the composer behaves identically either way.
  const {
    selectedAgentId,
    selectedRepoKey,
    selectedEnvId,
    selectionLocked,
    setSelectedRepoKey,
    setSelectedEnvId,
    applyAgentSelection,
    lockSelection,
  } = useComposerSelectionState();
  const selectedRepo =
    availableRepos?.find((r) => r.key === selectedRepoKey) ?? null;
  const selectedEnv =
    availableEnvironments?.find((e) => e.id === selectedEnvId) ?? null;

  // ── Agent selection (OXA app-agent-selector) ──────────────────────────────
  // Code mode is derived SOLELY from the selected agent's identity: a code agent
  // (isCode) runs the turn in a sandbox against a selected repo + environment
  // and reveals that tooling; a chat agent — or no agent at all — keeps the
  // plain composer. There is no manual toggle: an agentic coding flow requires a
  // coding agent (and a repo + environment) by construction (see the send gate
  // `codeGateBlocked` below).
  const selectedAgent =
    availableAgents?.find((a) => a.agentId === selectedAgentId) ?? null;
  const codeMode = selectedAgent?.isCode ?? false;

  // When code mode turns on, pre-fill the REQUIRED selections from the obvious
  // workspace defaults so the user SEES a ready-to-send target (they can still
  // change it before the first turn locks it): the default environment
  // (isDefault), and the default repo — the workspace-default repo when set,
  // else the sole option when there's exactly one. Skipped once locked (the
  // selection is already forced to the binding).
  React.useEffect(() => {
    if (!codeMode || selectionLocked) return;
    if (!selectedEnvId) {
      const defaultEnv = availableEnvironments?.find((e) => e.isDefault);
      if (defaultEnv) setSelectedEnvId(defaultEnv.id);
    }
    if (!selectedRepoKey) {
      const repos = availableRepos ?? [];
      const defaultRepo =
        (defaultRepoKey ? repos.find((r) => r.key === defaultRepoKey) : null) ??
        (repos.length === 1 ? repos[0] : null);
      if (defaultRepo) setSelectedRepoKey(defaultRepo.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-derive when codeMode flips on; availableRepos/availableEnvironments are stable per render from server props
  }, [codeMode]);

  const codeGateBlocked = codeMode && (!selectedRepo || !selectedEnvId);

  const formRef = React.useRef<HTMLFormElement>(null);

  // ── Responsive layout (mobile ≤767px) ──────────────────────────────────────
  const isMobile = useIsMobile();
  // Bottom sheet holding the overflow toolbar controls on phones.
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  // chat_ux_v2 mobile only: the attach tray bottom sheet opened by the
  // condensed row's plus button (see AttachTray / v2Mobile below).
  const [attachTrayOpen, setAttachTrayOpen] = React.useState(false);

  // ── Collapsible composer ───────────────────────────────────────────────────
  // Collapsed: textarea + attachment strip + agent toolbar hidden; only a slim
  // row (tap-to-expand affordance + send) remains, maximising chat height.
  // Hydration-safe: SSR + first paint render expanded, then the persisted
  // preference is applied after mount.
  const [composerCollapsed, setComposerCollapsed] = React.useState(false);
  React.useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(COMPOSER_COLLAPSED_STORAGE_KEY);
    } catch {
      // Storage unavailable — stay expanded.
    }
    if (stored === "1") setComposerCollapsed(true);
  }, []);

  // ── chat_ux_v2 condensed row (mobile + desktop) ───────────────────────────
  // A single condensed row (plus/textarea/cog?/send) replaces the entire
  // legacy toolbar ONLY when the unified session store is mounted — on a
  // phone-width viewport (v2Mobile, cog always shown — there's no rail there)
  // or any non-mobile viewport (v2Desktop, cog shown only at mid-width via
  // `showComposerCog`, wired by chat-shell-client.tsx's breakpoint check).
  // Every other surface (legacy toolbar, or mobile/desktop without the v2
  // session provider) renders byte-identical to before. The hook runs
  // unconditionally per rules-of-hooks; only the booleans below branch on it.
  const chatSession = useChatSessionContext();
  const v2Active = chatSession !== null;
  const v2Mobile = isMobile && v2Active;
  const v2Desktop = !isMobile && v2Active;

  // v2 wallet gate: a per-turn cap the wallet can't cover blocks sending —
  // the fix is the user's (add funds, or lower the cap in session settings),
  // so this disables send with inline copy rather than failing the turn.
  const walletGateBlocked =
    v2Active &&
    walletBalanceUsd != null &&
    chatSession.state.budgetUsd !== null &&
    walletBalanceUsd < chatSession.state.budgetUsd;

  // v2: the agent picker hands focus to the composer after a pick (see
  // agent-picker/focus-composer-event.ts) so "pick → type" is seamless.
  React.useEffect(() => {
    if (!v2Active) return;
    const focus = () => {
      (
        formRef.current?.elements.namedItem(
          "content",
        ) as HTMLTextAreaElement | null
      )?.focus();
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focus);
  }, [v2Active]);
  const v2Condensed = v2Mobile || v2Desktop;
  // The collapsed-composer preference never applies in the v2 condensed row:
  // there is no toggle to un-collapse it there (the button is hidden), and the
  // height budget requires the textarea always visible.
  const collapsed = composerCollapsed && !v2Condensed;

  const expandComposer = React.useCallback(() => {
    setComposerCollapsed(false);
    persistComposerCollapsed(false);
    // The textarea is CSS-hidden while collapsed (so drafts survive) — focus
    // it on the frame after the expanded layout commits.
    requestAnimationFrame(() => {
      (
        formRef.current?.elements.namedItem(
          "content",
        ) as HTMLTextAreaElement | null
      )?.focus();
    });
  }, []);

  const collapseComposer = React.useCallback(() => {
    setComposerCollapsed(true);
    persistComposerCollapsed(true);
  }, []);

  // Auto-expand when the user starts typing while collapsed: a printable key
  // pressed with focus outside any editable control re-opens the composer and
  // focuses the textarea (synchronously, so the keystroke lands in it).
  React.useEffect(() => {
    if (!composerCollapsed) return;
    function onDocumentKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return; // printable characters only
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      expandComposer();
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [composerCollapsed, expandComposer]);

  // ── Pinned chat context (org/repo + environment) ──────────────────────────
  // A pin sticks the current repo/environment selection to THIS conversation so
  // the assistant knows which repo the user means on every future turn (see
  // pinned-context.ts). Optional; repo/env are independent. Persistence is
  // keyed per-conversation, with a workspace-scoped draft key for a new chat
  // that migrates onto the real conversation key on first send.
  const [isPinned, setIsPinned] = React.useState(false);
  const pinKey = pinStorageKey(workspaceSlug, conversationId);
  const prevPinKeyRef = React.useRef(pinKey);
  React.useEffect(() => {
    const prevKey = prevPinKeyRef.current;
    prevPinKeyRef.current = pinKey;
    let stored = readStoredPins(pinKey);
    // Carry a draft pin onto the real conversation key the first time a new
    // chat gets an id (draft -> conv). Never migrate conv -> conv: switching
    // conversations must not leak one chat's pin into another.
    if (!stored && prevKey !== pinKey && prevKey.startsWith(DRAFT_PREFIX)) {
      const carried = readStoredPins(prevKey);
      if (carried) {
        writeStoredPins(pinKey, carried);
        writeStoredPins(prevKey, null);
        stored = carried;
      }
    }
    if (stored) {
      if (stored.repoKey) setSelectedRepoKey(stored.repoKey);
      if (stored.envId) setSelectedEnvId(stored.envId);
      setIsPinned(true);
    } else {
      setIsPinned(false);
    }
    // setSelectedRepoKey/setSelectedEnvId are stable store setters; they're
    // listed so this only re-runs on a conversation switch (pinKey change).
  }, [pinKey, setSelectedRepoKey, setSelectedEnvId]);

  // Toggle the pin, persisting a snapshot of the current selection (pin) or
  // clearing it (unpin). Writes happen here and in the selector handlers below,
  // never in a pinKey-keyed effect, so switching conversations can never write
  // the previous chat's selection under the new key.
  const togglePin = React.useCallback(() => {
    if (isPinned) {
      setIsPinned(false);
      writeStoredPins(pinKey, null);
    } else {
      setIsPinned(true);
      writeStoredPins(pinKey, {
        repoKey: selectedRepoKey,
        envId: selectedEnvId,
      });
    }
  }, [isPinned, pinKey, selectedRepoKey, selectedEnvId]);
  const handleSelectRepoKey = (key: string) => {
    setSelectedRepoKey(key);
    if (isPinned)
      writeStoredPins(pinKey, { repoKey: key, envId: selectedEnvId });
  };
  const handleSelectEnvId = (id: string) => {
    setSelectedEnvId(id);
    if (isPinned)
      writeStoredPins(pinKey, { repoKey: selectedRepoKey, envId: id });
  };

  // ── Slash commands ────────────────────────────────────────────────────────
  // `slashQuery` is the text after a lone leading slash ("/ci" -> "ci"), or
  // null when the input isn't a slash command. The menu is an autocomplete
  // affordance; the literal text is what gets sent, and the agent interprets it
  // (its system prompt documents the commands — see @oxagen/ai slash-commands).
  const [slashQuery, setSlashQuery] = React.useState<string | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = React.useState(0);
  const slashCommands = React.useMemo(
    () => (slashQuery === null ? [] : matchSlashCommands(slashQuery)),
    [slashQuery],
  );
  const slashOpen = slashQuery !== null && slashCommands.length > 0;

  // ── @-mentions ────────────────────────────────────────────────────────────
  // Two-stage picker anchored at a typed "@": stage 1 picks the reference TYPE
  // (files, repos, agents, graph nodes, …), stage 2 runs a type-scoped
  // search_references lookup. A selection inserts a readable "@Label"
  // placeholder; at submit each placeholder is swapped for its full
  // [:type|:slug|:location|:label] token (applyMentionPlaceholders) so the
  // literal token travels inline in `content` — the agent is taught the
  // grammar and the transcript re-renders tokens as inspectable chips.
  const [mentionAnchor, setMentionAnchor] = React.useState<number | null>(null);
  const [mentionStage, setMentionStage] = React.useState<"type" | "search">(
    "type",
  );
  const [mentionTypeSel, setMentionTypeSel] =
    React.useState<MentionTypeInfo | null>(null);
  const [mentionQuery, setMentionQuery] = React.useState("");
  const [mentionActiveIndex, setMentionActiveIndex] = React.useState(0);
  const [pendingMentions, setPendingMentions] = React.useState<
    ComposerMention[]
  >([]);
  const mentionOpen = mentionAnchor !== null;
  const mentionTypes = React.useMemo(
    () => matchMentionTypes(mentionStage === "type" ? mentionQuery : ""),
    [mentionStage, mentionQuery],
  );
  const { results: mentionResults, loading: mentionLoading } = useMentionSearch(
    {
      orgSlug,
      workspaceSlug,
      type: mentionTypeSel?.type ?? null,
      query: mentionQuery,
      enabled: mentionOpen && mentionStage === "search",
    },
  );
  const mentionItemCount =
    mentionStage === "type" ? mentionTypes.length : mentionResults.length;
  const closeMentionMenu = React.useCallback(() => {
    setMentionAnchor(null);
    setMentionStage("type");
    setMentionTypeSel(null);
    setMentionQuery("");
    setMentionActiveIndex(0);
  }, []);

  // Ref mirror of the code-mode + pin + agent selection so dispatchQueued
  // (queue-drain path) reads the CURRENT selection at drain time, same pattern
  // as activeServerIdsRef/parentMessageIdRef below.
  const codeStateRef = React.useRef({
    codeMode,
    selectedRepo,
    selectedEnvId,
    isPinned,
    selectedEnv,
    selectedAgentId,
  });
  React.useEffect(() => {
    codeStateRef.current = {
      codeMode,
      selectedRepo,
      selectedEnvId,
      isPinned,
      selectedEnv,
      selectedAgentId,
    };
  }, [
    codeMode,
    selectedRepo,
    selectedEnvId,
    isPinned,
    selectedEnv,
    selectedAgentId,
  ]);

  // Stable ref for the callback so the textarea onChange handler never
  // captures a stale closure — the identity of the ref never changes.
  const onInputHasContentChangeRef = React.useRef(onInputHasContentChange);
  React.useEffect(() => {
    onInputHasContentChangeRef.current = onInputHasContentChange;
  }, [onInputHasContentChange]);

  // Track whether the textarea currently has content so the parent can hide
  // the suggested-prompt chips while the user is typing.
  const inputHasContentRef = React.useRef(false);
  // State mirror for the v2 condensed row: its send button disables on empty
  // input (the spec bans native `required` validation — no browser tooltip,
  // ever — so emptiness must gate the button, and a ref can't re-render it).
  const [inputEmpty, setInputEmpty] = React.useState(true);
  const handleTextareaChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const hasContent = value.length > 0;
      setInputEmpty(value.trim().length === 0);
      if (hasContent !== inputHasContentRef.current) {
        inputHasContentRef.current = hasContent;
        onInputHasContentChangeRef.current?.(hasContent);
      }
      // Open the slash-command menu only while the whole input is a lone slash
      // token ("/", "/ci", …) — never mid-message — so it can't shadow normal
      // typing that happens to contain a slash.
      const slashMatch = /^\/([a-zA-Z]*)$/.exec(value);
      if (slashMatch) {
        setSlashQuery(slashMatch[1] ?? "");
        setSlashActiveIndex(0);
      } else if (slashQuery !== null) {
        setSlashQuery(null);
      }
      // @-mention trigger/tracking. Unlike slash commands the trigger works
      // mid-message: an "@" at the start or after whitespace opens the picker,
      // and the query is whatever sits between the anchor and the caret. Any
      // newline or edit that invalidates the anchor closes the menu.
      const caret = e.target.selectionStart ?? value.length;
      if (mentionAnchor !== null) {
        const valid =
          caret > mentionAnchor &&
          value[mentionAnchor] === "@" &&
          !value.slice(mentionAnchor + 1, caret).includes("\n");
        if (!valid) {
          closeMentionMenu();
        } else {
          const q = value.slice(mentionAnchor + 1, caret);
          if (q !== mentionQuery) {
            setMentionQuery(q);
            setMentionActiveIndex(0);
          }
        }
      } else if (
        caret > 0 &&
        value[caret - 1] === "@" &&
        (caret === 1 || /\s/.test(value[caret - 2] ?? ""))
      ) {
        setMentionAnchor(caret - 1);
        setMentionStage("type");
        setMentionTypeSel(null);
        setMentionQuery("");
        setMentionActiveIndex(0);
      }
    },
    [slashQuery, mentionAnchor, mentionQuery, closeMentionMenu],
  );

  // Apply a chosen slash command. Client-action commands (e.g. /pin) run
  // locally and clear the input; the rest insert "/<name> " so the user can
  // type args, then submit — the agent interprets the literal command.
  const applySlashCommand = React.useCallback(
    (command: SlashCommand) => {
      setSlashQuery(null);
      const ta = formRef.current?.elements.namedItem(
        "content",
      ) as HTMLTextAreaElement | null;
      if (command.clientAction === "pin") {
        if (ta) {
          ta.value = "";
          setInputEmpty(true);
          if (inputHasContentRef.current) {
            inputHasContentRef.current = false;
            onInputHasContentChangeRef.current?.(false);
          }
        }
        togglePin();
        return;
      }
      if (ta) {
        ta.value = `/${command.name} `;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        if (!inputHasContentRef.current) {
          inputHasContentRef.current = true;
          onInputHasContentChangeRef.current?.(true);
        }
      }
    },
    [togglePin],
  );

  // Stage 1 → 2: the user picked a reference type. Reset the typed filter back
  // to a bare "@" in the textarea and scope the live search to the type.
  const applyMentionType = React.useCallback(
    (info: MentionTypeInfo) => {
      const ta = formRef.current?.elements.namedItem(
        "content",
      ) as HTMLTextAreaElement | null;
      if (ta && mentionAnchor !== null) {
        const caret = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, mentionAnchor + 1) + ta.value.slice(caret);
        ta.focus();
        ta.setSelectionRange(mentionAnchor + 1, mentionAnchor + 1);
      }
      setMentionTypeSel(info);
      setMentionStage("search");
      setMentionQuery("");
      setMentionActiveIndex(0);
    },
    [mentionAnchor],
  );

  // Stage 2 selection: swap the "@query" for a readable "@Label" placeholder
  // and remember the structured mention for token substitution at submit.
  const applyMentionResult = React.useCallback(
    (result: MentionSearchResult) => {
      const ta = formRef.current?.elements.namedItem(
        "content",
      ) as HTMLTextAreaElement | null;
      if (ta && mentionAnchor !== null) {
        const mention = {
          type: result.type,
          slug: result.slug,
          location: result.location,
          label: result.label,
        };
        const placeholder = mentionPlaceholder(mention);
        const caret = ta.selectionStart ?? ta.value.length;
        const before = ta.value.slice(0, mentionAnchor);
        const after = ta.value.slice(caret);
        ta.value = `${before}${placeholder} ${after}`;
        const newCaret = before.length + placeholder.length + 1;
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
        if (!inputHasContentRef.current) {
          inputHasContentRef.current = true;
          onInputHasContentChangeRef.current?.(true);
        }
        setPendingMentions((prev) => [
          ...prev,
          {
            placeholder,
            mention,
            properties: result.properties,
            description: result.description,
          },
        ]);
      }
      closeMentionMenu();
    },
    [mentionAnchor, closeMentionMenu],
  );

  // Refs that always reflect the latest prop values so the queue-drain effect
  // (dep array [isStreaming]) reads the current parentMessageId / conversationId
  // rather than the stale closure captured when isStreaming last changed.
  const parentMessageIdRef = React.useRef(parentMessageId);
  React.useEffect(() => {
    parentMessageIdRef.current = parentMessageId;
  }, [parentMessageId]);
  const conversationIdRef = React.useRef(conversationId);
  React.useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  const activeServerIdsRef = React.useRef(activeServerIds);
  React.useEffect(() => {
    activeServerIdsRef.current = activeServerIds;
  }, [activeServerIds]);
  // Holds the id of the deferred-dispatch setTimeout so it can be cancelled on
  // unmount and before scheduling a new one.
  const dispatchTimerRef =
    React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(dispatchTimerRef.current), []);

  // FIFO queue for messages submitted while a stream is in flight (queue mode).
  const [queue, setQueue] = React.useState<QueuedMessage[]>([]);

  // ── Attachments (Phase 1: image-only) ─────────────────────────────────────
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
  // Inline "that file is too big" copy shown near the strip (spec-style, not
  // a toast) — set by queueAttachmentBatch when a client-side size pre-check
  // rejects a pick before it ever reaches the server.
  const [attachmentSizeError, setAttachmentSizeError] = React.useState<
    string | null
  >(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // In-flight XHRs keyed by attachment id, so `removeAttachment` can abort an
  // upload the user cancels mid-flight instead of racing a stale response.
  const xhrsRef = React.useRef<Map<string, XMLHttpRequest>>(new Map());
  React.useEffect(() => {
    const xhrs = xhrsRef.current;
    return () => {
      for (const xhr of xhrs.values()) xhr.abort();
    };
  }, []);

  const uploadAttachment = React.useCallback(
    (
      id: string,
      file: Blob,
      kind: "image" | "video" | "document",
      filename: string,
    ) => {
      const xhr = new XMLHttpRequest();
      xhrsRef.current.set(id, xhr);

      const fd = new FormData();
      fd.set("file", file, filename);
      fd.set("kind", kind);
      if (orgSlug) fd.set("orgSlug", orgSlug);
      if (workspaceSlug) fd.set("workspaceSlug", workspaceSlug);
      if (conversationIdRef.current)
        fd.set("conversationId", conversationIdRef.current);

      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        const progress = Math.round((evt.loaded / evt.total) * 100);
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, progress } : a)),
        );
      };

      xhr.onload = () => {
        xhrsRef.current.delete(id);
        let parsed: unknown;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          parsed = null;
        }
        if (
          xhr.status >= 200 &&
          xhr.status < 300 &&
          parsed &&
          typeof parsed === "object"
        ) {
          const item = parsed as {
            publicId?: string;
            kind?: string;
            name?: string;
            mimeType?: string;
            url?: string;
          };
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    status: "uploaded",
                    progress: 100,
                    publicId: item.publicId,
                    kind: item.kind,
                    name: item.name,
                    mimeType: item.mimeType,
                    url: item.url,
                  }
                : a,
            ),
          );
        } else {
          const message =
            parsed && typeof parsed === "object" && "error" in parsed
              ? String((parsed as { error?: unknown }).error)
              : `Upload failed (HTTP ${xhr.status})`;
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id ? { ...a, status: "error", error: message } : a,
            ),
          );
        }
      };

      xhr.onerror = () => {
        xhrsRef.current.delete(id);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? { ...a, status: "error", error: "Network error during upload" }
              : a,
          ),
        );
      };
      xhr.onabort = () => {
        xhrsRef.current.delete(id);
      };

      xhr.open("POST", "/api/v1/upload/attachment");
      xhr.send(fd);
    },
    [orgSlug, workspaceSlug],
  );

  const newLocalId = React.useCallback(
    () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [],
  );

  /**
   * Sample keyframes from a just-attached video and add them as HIDDEN image
   * attachments linked to the video's local id, uploading each as kind=image.
   * Best-effort: extractVideoFrames never throws (returns [] on an unsupported
   * codec), in which case the turn relies on a video-capable model or the
   * server returns an honest 422. Runs after the video is queued so the video
   * chip appears immediately.
   */
  const attachVideoKeyframes = React.useCallback(
    async (videoLocalId: string, file: File) => {
      const frames = await extractVideoFrames(file, {
        maxFrames: VIDEO_KEYFRAME_COUNT,
      });
      if (frames.length === 0) return;
      const baseName = file.name.replace(/\.[^.]+$/, "") || "video";
      const keyframes: PendingAttachment[] = frames.map((frame, i) => ({
        id: newLocalId(),
        // Wrap the blob as a File so the hidden attachment carries a stable
        // name/type; it never renders a chip (hidden), so previewUrl is unused
        // but kept non-empty for the shared cleanup path.
        file: new File([frame.blob], `${baseName}-frame-${i + 1}.webp`, {
          type: frame.blob.type || "image/webp",
        }),
        previewUrl: URL.createObjectURL(frame.blob),
        status: "uploading",
        progress: 0,
        hidden: true,
        keyframeForVideoLocalId: videoLocalId,
        attemptKind: "image",
      }));
      setAttachments((prev) => [...prev, ...keyframes]);
      queueMicrotask(() => {
        for (const kf of keyframes)
          uploadAttachment(kf.id, kf.file, "image", kf.file.name);
      });
    },
    [newLocalId, uploadAttachment],
  );

  /**
   * Shared attachment-queueing core: size-checks a pre-classified batch
   * against `ATTACHMENT_SIZE_LIMITS`, respects the MAX_ATTACHMENTS room
   * limit, and kicks off uploads (+ video keyframe sampling). Used by both
   * `addFiles` (legacy paste/drop/paperclip path — image/video only) and
   * `addClassifiedFiles` (chat_ux_v2 attach tray/popover — image/video/
   * document, since the server's "document" kind additionally accepts PDF)
   * so the two paths can never drift on size-checking, room-capping, or
   * upload dispatch.
   */
  const queueAttachmentBatch = React.useCallback(
    (classified: ClassifiedFile[]) => {
      if (classified.length === 0) return;
      let oversizeLimitMb: number | null = null;
      const withinLimit = classified.filter(({ file, kind }) => {
        if (file.size > ATTACHMENT_SIZE_LIMITS[kind]) {
          oversizeLimitMb = ATTACHMENT_SIZE_LIMITS[kind] / (1024 * 1024);
          return false;
        }
        return true;
      });
      setAttachmentSizeError(
        oversizeLimitMb !== null
          ? `That file is over ${oversizeLimitMb} MB. Try a smaller one.`
          : null,
      );
      if (withinLimit.length === 0) return;
      setAttachments((prev) => {
        // Only VISIBLE attachments count toward the strip cap; hidden keyframes
        // are added later out-of-band.
        const room = MAX_ATTACHMENTS - prev.filter((a) => !a.hidden).length;
        if (room <= 0) return prev;
        const accepted = withinLimit.slice(0, room);
        const next: PendingAttachment[] = accepted.map(({ file, kind }) => ({
          id: newLocalId(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: "uploading",
          progress: 0,
          attemptKind: kind,
        }));
        // Kick off uploads outside the updater (setState updaters must stay
        // pure) — deferred via microtask so this runs after the state commits.
        queueMicrotask(() => {
          accepted.forEach(({ file, kind }, i) => {
            const a = next[i]!;
            uploadAttachment(a.id, file, kind, file.name);
            if (kind === "video") void attachVideoKeyframes(a.id, file);
          });
        });
        return [...prev, ...next];
      });
    },
    [attachVideoKeyframes, newLocalId, uploadAttachment],
  );

  /** Add newly picked/pasted/dropped files as pending attachments and start
   * uploading each — legacy path, image/video only (the paperclip button,
   * paste, and drag-drop never offered a document picker). */
  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      const classified: ClassifiedFile[] = Array.from(files).flatMap(
        (file): ClassifiedFile[] => {
          if (file.type.startsWith("video/")) return [{ file, kind: "video" }];
          if (file.type.startsWith("image/")) return [{ file, kind: "image" }];
          return [];
        },
      );
      queueAttachmentBatch(classified);
    },
    [queueAttachmentBatch],
  );

  /** chat_ux_v2 attach tray/popover: classifies across all three
   * server-supported kinds, including `application/pdf` as "document" (the
   * legacy `addFiles` path never offered a document picker, so it stays
   * image/video-only above). */
  const addClassifiedFiles = React.useCallback(
    (files: FileList | File[]) => {
      const classified: ClassifiedFile[] = Array.from(files).flatMap(
        (file): ClassifiedFile[] => {
          if (file.type.startsWith("video/")) return [{ file, kind: "video" }];
          if (file.type === "application/pdf")
            return [{ file, kind: "document" }];
          if (file.type.startsWith("image/")) return [{ file, kind: "image" }];
          return [];
        },
      );
      queueAttachmentBatch(classified);
    },
    [queueAttachmentBatch],
  );

  const removeAttachment = React.useCallback((id: string) => {
    xhrsRef.current.get(id)?.abort();
    xhrsRef.current.delete(id);
    setAttachments((prev) => {
      // Removing a video also removes its hidden keyframes (else they'd upload,
      // block send via hasInFlightUploads, then be dropped as orphans at submit).
      const removeIds = new Set<string>([id]);
      for (const a of prev) {
        if (a.keyframeForVideoLocalId === id) removeIds.add(a.id);
      }
      for (const a of prev) {
        if (removeIds.has(a.id)) {
          xhrsRef.current.get(a.id)?.abort();
          xhrsRef.current.delete(a.id);
          URL.revokeObjectURL(a.previewUrl);
        }
      }
      return prev.filter((a) => !removeIds.has(a.id));
    });
  }, []);

  /** Re-attempt a failed upload with the exact same file + kind (applies to
   * every surface, legacy and v2 alike — a strict upgrade over the prior
   * "remove and re-pick" workaround). No-ops if the attachment isn't in the
   * `error` state or predates `attemptKind` tracking. */
  const retryAttachment = React.useCallback(
    (id: string) => {
      const target = attachments.find((a) => a.id === id);
      if (!target || target.status !== "error" || !target.attemptKind) return;
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, status: "uploading", progress: 0, error: undefined }
            : a,
        ),
      );
      uploadAttachment(id, target.file, target.attemptKind, target.file.name);
    },
    [attachments, uploadAttachment],
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    // Reset so selecting the SAME file again still fires onChange.
    e.target.value = "";
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(
      (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
    );
    if (files.length > 0) addFiles(files);
  };

  const [isDragOver, setIsDragOver] = React.useState(false);
  const handleDragOver = (e: React.DragEvent<HTMLFormElement>) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      setIsDragOver(true);
    }
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent<HTMLFormElement>) => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    setIsDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  // Release any un-revoked object URLs on unmount (submitted/removed
  // attachments already revoke theirs; this covers the unmount-while-pending
  // case).
  const attachmentsRef = React.useRef(attachments);
  React.useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  React.useEffect(
    () => () => {
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  // Resolve which text model is active (for reasoning capability check).
  const resolvedTextModelId =
    model.generate === null
      ? (model.model ?? modelConfig.text[model.tier ?? "fast"])
      : null;
  const resolvedTextModel =
    resolvedTextModelId !== null ? getModel(resolvedTextModelId) : undefined;
  const showEffortControl =
    model.generate === null && supportsReasoning(resolvedTextModel);

  // Placeholder text varies by media mode; in v2 a selected agent names the
  // recipient ("Message Software Architect…") so the pick → type flow reads
  // as addressing someone.
  const placeholder = disabled
    ? (disabledReason ?? "Composer paused.")
    : model.generate === "image"
      ? "Describe the image you want…"
      : model.generate === "video"
        ? "Describe the video you want…"
        : v2Active && selectedAgent
          ? `Message ${selectedAgent.name}…`
          : "Send a message…";

  function toggleGenerate(kind: "image" | "video") {
    if (model.generate === kind) {
      // Toggle off — return to text defaults.
      setModel((s) => ({
        ...s,
        generate: null,
        mediaTier: "basic",
        mediaModel: null,
      }));
    } else {
      // Toggle on — switch to this kind, pre-filling mediaModel from the
      // workspace/user seeded preference when available. When a seeded model
      // is present the tier is not needed (model wins), so clear mediaTier
      // to avoid sending a redundant field; otherwise fall back to "basic".
      setModel((s) => {
        const seeded =
          kind === "image" ? s.seededImageModel : s.seededVideoModel;
        return {
          ...s,
          generate: kind,
          mediaTier: seeded ? null : "basic",
          mediaModel: seeded ?? null,
        };
      });
    }
  }

  /** Build a FormData for the current form state + a given model snapshot. */
  function buildFormData(
    form: HTMLFormElement,
    modelSnapshot: ComposerModelState,
    attachmentsSnapshot: UploadedAttachmentMeta[] = [],
  ): FormData {
    const fd = new FormData(form);
    // Swap "@Label" mention placeholders for their full reference tokens so
    // the literal [:type|:slug|:location|:label] text travels in `content`.
    const contentValue = String(fd.get("content") ?? "");
    const contentWithTokens = applyMentionPlaceholders(
      contentValue,
      pendingMentions,
    );
    if (contentWithTokens !== contentValue)
      fd.set("content", contentWithTokens);
    if (conversationId) fd.set("conversationId", conversationId);
    if (parentMessageId) fd.set("parentMessageId", parentMessageId);
    if (attachmentsSnapshot.length > 0) {
      fd.set("attachments", JSON.stringify(attachmentsSnapshot));
    }
    if (modelSnapshot.generate === null) {
      if (modelSnapshot.model) {
        fd.set("model", modelSnapshot.model);
      } else {
        fd.set("tier", modelSnapshot.tier ?? "fast");
      }
      // Effort only when the resolved model supports reasoning.
      const resolvedId =
        modelSnapshot.model ?? modelConfig.text[modelSnapshot.tier ?? "fast"];
      const resolvedMeta = resolvedId ? getModel(resolvedId) : undefined;
      if (supportsReasoning(resolvedMeta) && modelSnapshot.effort) {
        fd.set("effort", modelSnapshot.effort);
      }
    } else {
      fd.set("generate", modelSnapshot.generate);
      if (modelSnapshot.mediaModel) {
        fd.set("mediaModel", modelSnapshot.mediaModel);
      } else {
        fd.set("mediaTier", modelSnapshot.mediaTier ?? "basic");
      }
    }
    if (activeServerIds.size > 0) {
      fd.set("activeServerIds", JSON.stringify([...activeServerIds]));
    }
    fd.set("budget", JSON.stringify(budgetPayload(modelSnapshot)));
    const code = codePayload(codeMode, selectedRepo, selectedEnv);
    if (code) fd.set("code", JSON.stringify(code));
    if (selectedAgentId) fd.set("agentId", selectedAgentId);
    // Pinned chat context — only when pinned and NOT in code mode (code mode
    // already conveys the repo/env via `code`, so the two never double up).
    if (isPinned && !codeMode) {
      const pinned = buildPinnedContext(selectedRepo, selectedEnv);
      if (pinned) fd.set("pinnedContext", JSON.stringify(pinned));
    }
    return fd;
  }

  /** Dispatch a FormData payload via the server action. */
  function dispatch(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) {
        setError(res.error ?? "Failed to send message");
      }
    });
  }

  /** Revoke every attachment's preview URL and clear the pending strip — called
   * once a snapshot of the attachments has been captured for send/queue. */
  function clearAttachments() {
    for (const a of attachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
    setAttachments([]);
    setAttachmentSizeError(null);
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (disabled) return;
    // Code mode requires BOTH a repo and an environment before the first
    // coding turn — the submit button is disabled for this too, but guard
    // here as well since Enter/Cmd+Enter bypass the button.
    if (codeGateBlocked || walletGateBlocked) return;
    // Never submit while an upload is still in flight — the model would
    // otherwise resolve an attachment the server hasn't finished persisting.
    if (hasInFlightUploads(attachments)) return;

    const contentRaw =
      (
        formRef.current?.elements.namedItem(
          "content",
        ) as HTMLTextAreaElement | null
      )?.value ?? "";
    if (contentRaw.trim().length === 0) return;

    const attachmentsSnapshot = toUploadedMeta(attachments);

    // A code turn binds the conversation's coding target for its lifetime — lock
    // the pickers client-side now (repo/env/agent become read-only) so the user
    // can't retarget mid-conversation. The server claims the durable binding on
    // this same turn; locking here means the UI doesn't wait for a reload.
    if (codeMode) lockSelection();

    // If a stream is in flight, honour the pending-prompt behavior.
    if (isStreaming && !pending) {
      if (pendingPromptBehavior === "interrupt") {
        // Abort the current stream, then submit immediately.
        onInterrupt?.();
        const fd = buildFormData(e.currentTarget, model, attachmentsSnapshot);
        formRef.current?.reset();
        setPendingMentions([]);
        closeMentionMenu();
        clearAttachments();
        dispatch(fd);
      } else {
        // queue mode: capture the message, model state, and attachments; clear
        // the textarea + pending strip. Mention placeholders are tokenized at
        // queue time so the drained FormData needs no mention state.
        const snapshot = model;
        const content = applyMentionPlaceholders(contentRaw, pendingMentions);
        setQueue((prev) => [
          ...prev,
          {
            id: nextQueueId(),
            content,
            modelState: snapshot,
            attachments: attachmentsSnapshot,
          },
        ]);
        setPendingMentions([]);
        closeMentionMenu();
        clearAttachments();
        (
          formRef.current?.elements.namedItem(
            "content",
          ) as HTMLTextAreaElement | null
        )?.dispatchEvent(new Event("input"));
        // Reset the native textarea value directly so the placeholder reappears.
        const ta = formRef.current?.elements.namedItem(
          "content",
        ) as HTMLTextAreaElement | null;
        if (ta) ta.value = "";
        // Notify parent that input is now empty (chips should reappear).
        if (inputHasContentRef.current) {
          inputHasContentRef.current = false;
          onInputHasContentChangeRef.current?.(false);
        }
      }
      return;
    }

    const fd = buildFormData(e.currentTarget, model, attachmentsSnapshot);
    formRef.current?.reset();
    setPendingMentions([]);
    closeMentionMenu();
    clearAttachments();
    // Notify parent that input is now empty after reset (chips should reappear).
    if (inputHasContentRef.current) {
      inputHasContentRef.current = false;
      onInputHasContentChangeRef.current?.(false);
    }
    dispatch(fd);
  };

  /**
   * Build a synthetic FormData for a queued message and dispatch it.
   *
   * Read parentMessageId / conversationId / activeServerIds from refs so we get
   * the CURRENT values (updated after the completed stream persisted the
   * assistant reply and advanced activeLeafMessageId), not the stale closure
   * captured when the message was enqueued.
   */
  const dispatchQueued = React.useCallback(
    (next: QueuedMessage) => {
      const fd = new FormData();
      fd.set("content", next.content);
      const currentConversationId = conversationIdRef.current;
      const currentParentMessageId = parentMessageIdRef.current;
      if (currentConversationId)
        fd.set("conversationId", currentConversationId);
      if (currentParentMessageId)
        fd.set("parentMessageId", currentParentMessageId);
      if (next.attachments.length > 0) {
        fd.set("attachments", JSON.stringify(next.attachments));
      }
      const ms = next.modelState;
      if (ms.generate === null) {
        if (ms.model) {
          fd.set("model", ms.model);
        } else {
          fd.set("tier", ms.tier ?? "fast");
        }
        const resolvedId = ms.model ?? modelConfig.text[ms.tier ?? "fast"];
        const resolvedMeta = resolvedId ? getModel(resolvedId) : undefined;
        if (supportsReasoning(resolvedMeta) && ms.effort) {
          fd.set("effort", ms.effort);
        }
      } else {
        fd.set("generate", ms.generate);
        if (ms.mediaModel) {
          fd.set("mediaModel", ms.mediaModel);
        } else {
          fd.set("mediaTier", ms.mediaTier ?? "basic");
        }
      }
      const currentActiveServerIds = activeServerIdsRef.current;
      if (currentActiveServerIds.size > 0) {
        fd.set("activeServerIds", JSON.stringify([...currentActiveServerIds]));
      }
      fd.set("budget", JSON.stringify(budgetPayload(ms)));
      const currentCode = codeStateRef.current;
      const code = codePayload(
        currentCode.codeMode,
        currentCode.selectedRepo,
        currentCode.selectedEnv,
      );
      if (code) fd.set("code", JSON.stringify(code));
      if (currentCode.selectedAgentId)
        fd.set("agentId", currentCode.selectedAgentId);
      if (currentCode.isPinned && !currentCode.codeMode) {
        const pinned = buildPinnedContext(
          currentCode.selectedRepo,
          currentCode.selectedEnv,
        );
        if (pinned) fd.set("pinnedContext", JSON.stringify(pinned));
      }
      // Defer the dispatch out of the caller (effect / event handler) so the
      // queue-drain doesn't cascade synchronously within a React effect
      // (satisfies react-hooks/set-state-in-effect) and so send-now doesn't
      // start a transition inside an unrelated render.
      clearTimeout(dispatchTimerRef.current);
      dispatchTimerRef.current = setTimeout(() => dispatch(fd), 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- *Ref values are stable refs; dispatch/modelConfig are stable enough across renders for the drain semantics
    [modelConfig],
  );

  // When streaming ends, drain the queue head. Each drained message restarts
  // the stream (isStreaming → true), so this effect re-fires when THAT turn
  // finishes and drains the next item — sequentially emptying the whole queue.
  const prevIsStreamingRef = React.useRef(isStreaming);
  React.useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      if (!next) return;
      dispatchQueued(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  /** Remove a queued message by id. */
  const removeQueued = React.useCallback((id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  }, []);

  /** Replace a queued message's content (inline edit). */
  const editQueued = React.useCallback((id: string, content: string) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, content } : q)));
  }, []);

  /** Move a queued message up or down one slot (clamped at the ends). */
  const reorderQueued = React.useCallback(
    (index: number, direction: "up" | "down") => {
      setQueue((prev) => {
        const target = direction === "up" ? index - 1 : index + 1;
        if (target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(index, 1);
        if (!moved) return prev;
        next.splice(target, 0, moved);
        return next;
      });
    },
    [],
  );

  /**
   * Send a queued message now: jump it to the front of the queue. When no
   * stream is in flight, dispatch it immediately (the user wants it gone now);
   * otherwise it will drain first when the active turn completes.
   */
  const sendQueuedNow = React.useCallback(
    (id: string) => {
      if (!isStreaming) {
        // No stream in flight: drain this item right away and drop it from the
        // queue. Read the target from current state (not inside the updater) so
        // the dispatch is independent of when React commits the state change.
        const target = queue.find((q) => q.id === id);
        if (!target) return;
        setQueue((prev) => prev.filter((q) => q.id !== id));
        dispatchQueued(target);
        return;
      }
      // Stream in flight: promote to the front so it drains first.
      setQueue((prev) => {
        const item = prev.find((q) => q.id === id);
        if (!item) return prev;
        return [item, ...prev.filter((q) => q.id !== id)];
      });
    },
    [isStreaming, dispatchQueued, queue],
  );

  /**
   * IME-safe keyboard handler.
   * Guard: never submit mid-composition (isComposing / keyCode 229).
   * enterToSubmit=true  : Enter → submit, Shift+Enter → newline.
   * enterToSubmit=false : Enter → newline, Cmd/Ctrl+Enter → submit.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition guard — never submit during composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    // @-mention menu navigation takes precedence while it's open — same
    // contract as the slash menu below: Enter/Tab select, arrows cycle,
    // Escape dismisses, and nothing leaks through to submit.
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (mentionItemCount > 0)
          setMentionActiveIndex((i) => (i + 1) % mentionItemCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (mentionItemCount > 0) {
          setMentionActiveIndex(
            (i) => (i - 1 + mentionItemCount) % mentionItemCount,
          );
        }
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (mentionStage === "type") {
          e.preventDefault();
          const info = mentionTypes[mentionActiveIndex] ?? mentionTypes[0];
          if (info) applyMentionType(info);
          return;
        }
        if (mentionResults.length > 0) {
          e.preventDefault();
          const result =
            mentionResults[mentionActiveIndex] ?? mentionResults[0];
          if (result) applyMentionResult(result);
          return;
        }
        // No results to select — close the menu and let Enter behave normally
        // (submit/newline) so a literal "@..." can still be sent as text.
        closeMentionMenu();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentionMenu();
        return;
      }
    }

    // Slash-command menu navigation takes precedence while it's open — Enter
    // selects the highlighted command instead of submitting the form.
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActiveIndex((i) => (i + 1) % slashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActiveIndex(
          (i) => (i - 1 + slashCommands.length) % slashCommands.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = slashCommands[slashActiveIndex] ?? slashCommands[0];
        if (cmd) applySlashCommand(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
    }

    const isEnter = e.key === "Enter";
    if (!isEnter) return;

    const isEmpty = (e.currentTarget.value ?? "").trim().length === 0;
    if (isEmpty) {
      // Suppress empty-submit in all modes; allow newline via default.
      if (enterToSubmit && !e.shiftKey) e.preventDefault();
      return;
    }

    if (pending || disabled || codeGateBlocked || walletGateBlocked) return;

    if (enterToSubmit) {
      if (!e.shiftKey) {
        // Enter (no shift) → submit.
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
      // Shift+Enter falls through → browser inserts newline.
    } else {
      // Default (enterToSubmit=false): Cmd/Ctrl+Enter → submit.
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
      // Plain Enter falls through → browser inserts newline.
    }
  };

  const uploadsInFlight = hasInFlightUploads(attachments);
  // Video keyframes are hidden derived attachments — the pending strip and the
  // attachment cap only reflect the visible ones the user actually picked.
  const visibleAttachments = attachments.filter((a) => !a.hidden);
  // Without a resolved org+workspace scope the upload endpoint's membership
  // guard can't run — degrade to a text-only composer rather than uploading
  // with a malformed request.
  const canAttach = Boolean(orgSlug) && Boolean(workspaceSlug);
  const hasRepos = (availableRepos?.length ?? 0) > 0;
  const hasEnvironments = (availableEnvironments?.length ?? 0) > 0;
  // The compact context controls show whenever there's a repo or environment
  // to choose from — in both pin mode and code mode (they share the selection
  // state and render as one small footer row).
  const showContextControls = hasRepos || hasEnvironments;

  // Shared between the desktop toolbar row and the mobile overflow sheet —
  // exactly one of the two renders at a time (see `isMobile` branches below).
  const effortSelect = (
    <Select
      value={model.effort ?? "medium"}
      onValueChange={(v) =>
        setModel((s) => ({ ...s, effort: v as EffortLevel }))
      }
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "w-auto gap-1.5 border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-muted focus:ring-0",
          isMobile ? "min-h-11" : "h-8",
        )}
        aria-label={`Reasoning effort: ${model.effort ?? "medium"}`}
      >
        <Brain className="h-3.5 w-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="low">Low effort</SelectItem>
        <SelectItem value="medium">Medium effort</SelectItem>
        <SelectItem value="high">High effort</SelectItem>
      </SelectPopup>
    </Select>
  );

  const budgetControl = (
    <BudgetControl
      budgetEnabled={model.budgetEnabled}
      budgetUsd={model.budgetUsd}
      budgetMode={model.budgetMode}
      budgetGracePct={model.budgetGracePct}
      governance={workspaceBudgetGovernance}
      onChange={(patch) =>
        setModel((s) =>
          applyWorkspaceBudgetGovernance(
            { ...s, ...patch },
            workspaceBudgetGovernance ?? null,
          ),
        )
      }
    />
  );

  // Shared send-button aria-label — used by both the v2 condensed row
  // (mobile and desktop) and the legacy toolbar's Send button below, so all
  // three can never drift.
  const sendAriaLabel =
    isStreaming && pendingPromptBehavior === "interrupt"
      ? "Interrupt and send"
      : isStreaming
        ? "Queue message"
        : "Send message";

  // v2 condensed row cog dot (mobile always, desktop at mid-width): a broken
  // selection (warning) takes precedence over the plain "settings differ from
  // defaults" accent — it needs attention regardless of whether other
  // settings also changed.
  const v2SelectionIssues = React.useMemo(
    () =>
      chatSession
        ? sessionSelectionIssues(chatSession.state, {
            repos: availableRepos ?? [],
            environments: availableEnvironments ?? [],
            branches: null,
          })
        : [],
    [chatSession, availableRepos, availableEnvironments],
  );
  const v2HasIssues = v2SelectionIssues.length > 0;
  const v2IsDirty = chatSession?.isDirty ?? false;
  const cogDotClass = v2HasIssues
    ? "bg-destructive"
    : v2IsDirty
      ? "bg-primary"
      : null;
  const cogAriaLabel = `Session settings${
    v2HasIssues ? ", attention needed" : v2IsDirty ? ", settings changed" : ""
  }`;

  return (
    <div className="flex flex-col">
      <form
        ref={formRef}
        onSubmit={onSubmit}
        onDragOver={canAttach ? handleDragOver : undefined}
        onDragLeave={canAttach ? handleDragLeave : undefined}
        onDrop={canAttach ? handleDrop : undefined}
        className={cn(
          "flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring",
          collapsed && "gap-0 py-1.5",
          // v2 condensed row (mobile or desktop) at-rest budget is ≤64px: 44px
          // controls + 2×8px padding + 2px border = 62. p-3 (12px) would
          // overshoot to 70.
          v2Condensed && "py-2",
          isDragOver && "ring-2 ring-primary",
        )}
      >
        {/* Hidden native file input — triggered by the paperclip button. Accepts
          images and videos; a video's keyframes are sampled client-side for the
          vision-only fallback path (Phase 2). */}
        {canAttach ? (
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            onChange={handleFileInputChange}
            aria-hidden="true"
            tabIndex={-1}
          />
        ) : null}
        {/* CSS-hidden (not unmounted) while collapsed so the draft text and the
          form's `content` field survive collapse/expand round-trips. In the
          v2 condensed row (mobile or desktop) the textarea instead lives
          inline in the row below (see `v2Condensed` branch further down) —
          rendering NOTHING here avoids a duplicate `name="content"` field. */}
        {!v2Condensed ? (
          <div className="relative">
            {slashOpen ? (
              <SlashCommandMenu
                commands={slashCommands}
                activeIndex={slashActiveIndex}
                onSelect={applySlashCommand}
                onHoverIndex={setSlashActiveIndex}
              />
            ) : null}
            {mentionOpen ? (
              <MentionMenu
                stage={mentionStage}
                types={mentionTypes}
                results={mentionResults}
                selectedType={mentionTypeSel}
                activeIndex={mentionActiveIndex}
                loading={mentionLoading}
                query={mentionQuery}
                onSelectType={applyMentionType}
                onSelectResult={applyMentionResult}
                onHoverIndex={setMentionActiveIndex}
              />
            ) : null}
            <Textarea
              name="content"
              required
              placeholder={placeholder}
              rows={isMobile ? 2 : 3}
              disabled={pending || disabled}
              onKeyDown={onKeyDown}
              onChange={handleTextareaChange}
              onBlur={() => {
                setSlashQuery(null);
                closeMentionMenu();
              }}
              onPaste={canAttach ? handlePaste : undefined}
              className={cn(
                "border-none bg-transparent shadow-none focus-visible:ring-0",
                composerCollapsed && "hidden",
              )}
            />
          </div>
        ) : null}
        {/* Pending attachment strip — thumbnails with upload progress/remove.
          Hidden video keyframes are excluded (they ride with their video). */}
        {visibleAttachments.length > 0 && !collapsed ? (
          <div className="flex flex-wrap gap-2" data-testid="attachment-strip">
            {visibleAttachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                onRemove={removeAttachment}
                onRetry={retryAttachment}
                compact={v2Active}
              />
            ))}
          </div>
        ) : null}
        {/* Inline size-rejection copy (spec-style, near the strip — never a
          toast) — set by queueAttachmentBatch's client-side pre-check. */}
        {attachmentSizeError && !collapsed ? (
          <p
            className="text-xs text-destructive"
            data-testid="attachment-size-error"
          >
            {attachmentSizeError}
          </p>
        ) : null}
        {/* Pending @-mention strip — the structured references attached to this
          draft. Each chip is hover-inspectable; removing one only detaches the
          reference (the "@Label" text stays as plain words). */}
        {pendingMentions.length > 0 && !collapsed ? (
          <div className="flex flex-wrap gap-1.5" data-testid="mention-strip">
            {pendingMentions.map((m, index) => (
              <MentionChip
                key={`${m.mention.type}:${m.mention.slug}:${index}`}
                mention={m.mention}
                properties={m.properties}
                description={m.description}
                onRemove={() =>
                  setPendingMentions((prev) =>
                    prev.filter((_, i) => i !== index),
                  )
                }
              />
            ))}
          </div>
        ) : null}
        {/* Queued messages (queue mode): ordered list with reorder / edit /
          remove / send-now controls. */}
        {!collapsed && (
          <MessageQueue
            items={queue.map((q) => ({ id: q.id, content: q.content }))}
            isStreaming={isStreaming}
            onRemove={removeQueued}
            onReorder={reorderQueued}
            onEdit={editQueued}
            onSendNow={sendQueuedNow}
          />
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {disabled && disabledReason ? (
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
        ) : null}
        {codeGateBlocked && !collapsed ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="code-mode-gate-hint"
          >
            Select a repository and environment to start coding.
          </p>
        ) : null}
        {walletGateBlocked && !collapsed ? (
          <p
            className="text-xs text-destructive"
            data-testid="wallet-gate-hint"
          >
            Wallet balance is below your cap. Add funds or lower the cap.
          </p>
        ) : null}

        {/* Compact context controls — a single small row UNDER the textarea:
          org/repository on the bottom-left, environment (+ the open-PR chip and
          pin toggle) on the bottom-right. Replaces the two former heavy bars
          (code-mode toolbar / pin context bar) that sat ABOVE the composer and
          each duplicated the repo/env selectors. Code mode drops the pin (both
          selections are required to send anyway); pin mode keeps it. Hidden
          while collapsed, and hidden entirely in the v2 condensed row (mobile
          or desktop — neither has room for it; Code/pin selection moves into
          the session settings surface via the cog / rail panel). */}
        {!v2Condensed && !collapsed && (showContextControls || codeSessionPr) ? (
          <ComposerContextControls
            repositories={availableRepos ?? []}
            environments={availableEnvironments ?? []}
            selectedRepoKey={selectedRepoKey}
            selectedEnvId={selectedEnvId}
            onSelectRepo={(repo) => handleSelectRepoKey(repo.key)}
            onSelectEnv={handleSelectEnvId}
            mode={codeMode ? "code" : "pin"}
            isPinned={isPinned}
            onTogglePin={togglePin}
            pr={codeSessionPr ?? null}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            disabled={pending || disabled}
            locked={selectionLocked}
          />
        ) : null}

        {/* v2 condensed row: ONE row replaces the entire toolbar below — plus
          (attach) / textarea / cog (session settings, conditional on
          v2Desktop) / send. v2Mobile always shows the cog (no rail exists on
          phone); v2Desktop shows it only when `showComposerCog` is true (the
          rail is hidden at mid-width — chat-shell-client.tsx's breakpoint
          check guarantees the rail and this cog are never both visible). The
          textarea lives HERE (not in the block near the top of the form) so
          the attachment/mention strips, queue, error, and code-gate hint all
          render ABOVE this row, and the composer stays within the ≤64px
          at-rest height budget. The slash/mention popup menus anchor to this
          row's `relative` wrapper, popping up directly above it. */}
        {v2Condensed ? (
          <div className="relative">
            {slashOpen ? (
              <SlashCommandMenu
                commands={slashCommands}
                activeIndex={slashActiveIndex}
                onSelect={applySlashCommand}
                onHoverIndex={setSlashActiveIndex}
              />
            ) : null}
            {mentionOpen ? (
              <MentionMenu
                stage={mentionStage}
                types={mentionTypes}
                results={mentionResults}
                selectedType={mentionTypeSel}
                activeIndex={mentionActiveIndex}
                loading={mentionLoading}
                query={mentionQuery}
                onSelectType={applyMentionType}
                onSelectResult={applyMentionResult}
                onHoverIndex={setMentionActiveIndex}
              />
            ) : null}
            <CondensedComposerRow
              testId={v2Mobile ? "composer-v2-mobile-row" : "composer-v2-desktop-row"}
              canAttach={canAttach}
              pending={pending}
              disabled={disabled}
              attachmentCount={visibleAttachments.length}
              // v2Mobile: opens the AttachTray bottom sheet below. v2Desktop
              // supplies its own trigger (attachTrigger) so this never fires
              // there — see CondensedComposerRow's attachTrigger doc.
              onAttachClick={() => setAttachTrayOpen(true)}
              attachTrigger={
                v2Desktop ? (
                  <AttachPopover
                    disabled={
                      pending ||
                      disabled ||
                      visibleAttachments.length >= MAX_ATTACHMENTS
                    }
                    onPickFiles={addClassifiedFiles}
                  />
                ) : undefined
              }
              placeholder={placeholder}
              onKeyDown={onKeyDown}
              onChange={handleTextareaChange}
              onBlur={() => {
                setSlashQuery(null);
                closeMentionMenu();
              }}
              onPaste={canAttach ? handlePaste : undefined}
              showCog={v2Mobile || showComposerCog}
              cogAriaLabel={cogAriaLabel}
              cogDotClass={cogDotClass}
              onOpenSessionSettings={onOpenSessionSettings}
              sendDisabled={
                pending ||
                disabled ||
                uploadsInFlight ||
                codeGateBlocked ||
                walletGateBlocked ||
                // Empty input disables send (attachments alone still send).
                (inputEmpty && visibleAttachments.length === 0)
              }
              sendAriaLabel={sendAriaLabel}
            />
          </div>
        ) : (
          <>
            {/* Toolbar. Collapsed: a slim single row (~40px) with a tap-to-expand
          affordance, the send button, and the expand chevron. Expanded on
          desktop: the full control row (flex-wrap as an overflow safety net).
          Expanded on mobile: only the essentials inline (attach, code mode,
          send) — everything else lives in the bottom overflow sheet. */}
            <div
              className={cn(
                "flex items-center gap-1",
                !composerCollapsed && "flex-wrap",
              )}
            >
              {composerCollapsed ? (
                <button
                  type="button"
                  data-testid="composer-expand-affordance"
                  onClick={expandComposer}
                  className="h-10 min-w-0 flex-1 truncate rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-muted"
                >
                  {placeholder}
                </button>
              ) : (
                <>
                  {/* Model picker + agent picker + reasoning effort — inline on
                desktop, in the overflow sheet on mobile. The agent picker:
                selecting a code agent reveals the repo/code tooling + UI (and
                runs the turn in the sandbox); a chat agent / the default keeps
                the plain composer. Renders nothing when the workspace has no
                agents, so agent-less workspaces are unaffected. */}
                  {!isMobile && (
                    <>
                      <ModelPicker
                        value={model}
                        onChange={setModel}
                        modelConfig={modelConfig}
                      />
                      <AgentContextChip
                        agents={availableAgents ?? []}
                        repos={availableRepos ?? []}
                        environments={availableEnvironments ?? []}
                        defaultRepoKey={defaultRepoKey ?? null}
                        defaultEnvId={defaultEnvId ?? null}
                        defaultAgentId={defaultAgentId ?? null}
                        onSetDefaultAgent={onSetDefaultAgent}
                        selectedAgentId={selectedAgentId}
                        selectedRepoKey={selectedRepoKey}
                        selectedEnvId={selectedEnvId}
                        onApply={applyAgentSelection}
                        locked={selectionLocked}
                      />
                      {showEffortControl && effortSelect}
                    </>
                  )}

                  {/* Attach image or video — opens the native file picker;
                paste/drag-drop also work. Essential — always inline. */}
                  {canAttach ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Attach image or video"
                      disabled={
                        pending ||
                        disabled ||
                        visibleAttachments.length >= MAX_ATTACHMENTS
                      }
                      onClick={() => fileInputRef.current?.click()}
                      className={cn("p-0", isMobile ? "h-11 w-11" : "h-8 w-8")}
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                  ) : null}

                  {/* Image / video generation toggles — inline on desktop, in the
                overflow sheet on mobile. */}
                  {!isMobile && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Generate image"
                        aria-pressed={model.generate === "image"}
                        onClick={() => toggleGenerate("image")}
                        className={cn(
                          "h-8 w-8 p-0",
                          model.generate === "image" &&
                            "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
                        )}
                      >
                        <ImageIcon className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Generate video"
                        aria-pressed={model.generate === "video"}
                        onClick={() => toggleGenerate("video")}
                        className={cn(
                          "h-8 w-8 p-0",
                          model.generate === "video" &&
                            "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
                        )}
                      >
                        <Video className="h-4 w-4" />
                      </Button>
                    </>
                  )}

                  {/* Code mode is governed SOLELY by the selected agent's identity
                (a code agent turns it on and reveals the repo/environment
                pickers below) — there is no manual toggle. Selecting a coding
                agent is the deliberate act that enters the agentic coding flow. */}

                  {!isMobile && (
                    <>
                      {/* MCP server activation picker — only when servers are available */}
                      {(availableMcpServers?.length ?? 0) > 0 && (
                        <McpServerPicker
                          servers={availableMcpServers!}
                          activeServerIds={activeServerIds}
                          onActiveServerIdsChange={setActiveServerIds}
                        />
                      )}

                      {/* Per-turn dollar budget — off by default. Every change is
                    re-clamped against workspace governance (OXA-2081) so a
                    "ceiling" can never be exceeded, even transiently, by a
                    member's own edit. */}
                      {budgetControl}
                    </>
                  )}

                  {/* Mobile: overflow controls live in a bottom sheet. */}
                  {isMobile && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="More composer options"
                      aria-expanded={overflowOpen}
                      data-testid="composer-overflow-btn"
                      onClick={() => setOverflowOpen(true)}
                      className="h-11 w-11 p-0"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                    </Button>
                  )}
                </>
              )}
              <div className="ml-auto flex items-center gap-1.5">
                {isStreaming && queue.length > 0 ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {queue.length} queued
                  </span>
                ) : null}
                <Button
                  type="submit"
                  // Disabled while any attachment upload is still in flight — sending
                  // now would resolve a publicId the server hasn't finished persisting.
                  // Also disabled while code mode is on but repo/environment aren't
                  // both selected yet (see codeGateBlocked).
                  disabled={
                    pending ||
                    disabled ||
                    uploadsInFlight ||
                    codeGateBlocked ||
                    walletGateBlocked
                  }
                  size="sm"
                  aria-label={
                    isStreaming && pendingPromptBehavior === "interrupt"
                      ? "Interrupt and send"
                      : isStreaming
                        ? "Queue message"
                        : "Send message"
                  }
                  className={cn(isMobile && !composerCollapsed && "h-11")}
                  style={
                    !pending &&
                    !disabled &&
                    !uploadsInFlight &&
                    !codeGateBlocked
                      ? {
                          background: "var(--primary)",
                          border: "none",
                          color: "var(--primary-foreground)",
                        }
                      : undefined
                  }
                >
                  <Send className="h-3.5 w-3.5" />
                  {pending
                    ? "Sending…"
                    : uploadsInFlight
                      ? "Uploading…"
                      : isStreaming && pendingPromptBehavior === "interrupt"
                        ? "Interrupt"
                        : "Send"}
                </Button>

                {/* Collapse / expand the whole composer — persists to localStorage. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={
                    composerCollapsed ? "Expand composer" : "Collapse composer"
                  }
                  aria-expanded={!composerCollapsed}
                  data-testid="composer-collapse-toggle"
                  onClick={
                    composerCollapsed ? expandComposer : collapseComposer
                  }
                  className={cn(
                    "p-0",
                    isMobile && !composerCollapsed ? "h-11 w-11" : "h-8 w-8",
                  )}
                >
                  {composerCollapsed ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </form>

      {/* chat_ux_v2 mobile only: the attach tray opened by the condensed
        row's plus button (see onAttachClick above). v2Desktop uses
        AttachPopover instead — attachTrigger renders it inline within the
        row itself, so it needs no sibling mount point here. */}
      {v2Mobile && canAttach ? (
        <AttachTray
          open={attachTrayOpen}
          onOpenChange={setAttachTrayOpen}
          onCapturePhoto={addFiles}
          onPickPhotos={addFiles}
          onPickDocuments={addClassifiedFiles}
        />
      ) : null}

      {/* Mobile overflow sheet: the non-essential toolbar controls as
        thumb-friendly full-width rows (≥44px tall). Portaled to the body, so
        interactive children here are OUTSIDE the form — every control is a
        type="button"/stateful picker, never a submit. Never in v2Mobile — its
        four essential controls are all inline in the condensed row above. */}
      {isMobile && !composerCollapsed && !v2Mobile ? (
        <Sheet open={overflowOpen} onOpenChange={setOverflowOpen}>
          <SheetPopup
            side="bottom"
            data-testid="composer-overflow-sheet"
            className="max-h-[70vh] rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="mb-2">
              <SheetTitle className="text-sm">Composer options</SheetTitle>
              <SheetDescription className="sr-only">
                Model, generation, MCP server, and budget controls for this
                turn.
              </SheetDescription>
            </SheetHeader>
            <SheetPanel className="gap-1">
              <div className="flex min-h-11 items-center justify-between gap-2">
                <span className="text-sm">Model</span>
                <ModelPicker
                  value={model}
                  onChange={setModel}
                  modelConfig={modelConfig}
                />
              </div>
              {(availableAgents?.length ?? 0) > 0 && (
                <div className="flex min-h-11 items-center justify-between gap-2">
                  <span className="text-sm">Agent</span>
                  <AgentContextChip
                    agents={availableAgents ?? []}
                    repos={availableRepos ?? []}
                    environments={availableEnvironments ?? []}
                    defaultRepoKey={defaultRepoKey ?? null}
                    defaultEnvId={defaultEnvId ?? null}
                    defaultAgentId={defaultAgentId ?? null}
                    onSetDefaultAgent={onSetDefaultAgent}
                    selectedAgentId={selectedAgentId}
                    selectedRepoKey={selectedRepoKey}
                    selectedEnvId={selectedEnvId}
                    onApply={applyAgentSelection}
                    locked={selectionLocked}
                  />
                </div>
              )}
              {showEffortControl && (
                <div className="flex min-h-11 items-center justify-between gap-2">
                  <span className="text-sm">Reasoning effort</span>
                  {effortSelect}
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                aria-label="Generate image"
                aria-pressed={model.generate === "image"}
                onClick={() => toggleGenerate("image")}
                className={cn(
                  "h-11 w-full justify-start gap-2 px-2 text-sm",
                  model.generate === "image" &&
                    "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
                )}
              >
                <ImageIcon className="h-4 w-4" />
                Generate image
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label="Generate video"
                aria-pressed={model.generate === "video"}
                onClick={() => toggleGenerate("video")}
                className={cn(
                  "h-11 w-full justify-start gap-2 px-2 text-sm",
                  model.generate === "video" &&
                    "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
                )}
              >
                <Video className="h-4 w-4" />
                Generate video
              </Button>
              {(availableMcpServers?.length ?? 0) > 0 && (
                <div className="flex min-h-11 items-center justify-between gap-2">
                  <span className="text-sm">MCP servers</span>
                  <McpServerPicker
                    servers={availableMcpServers!}
                    activeServerIds={activeServerIds}
                    onActiveServerIdsChange={setActiveServerIds}
                  />
                </div>
              )}
              <div className="flex min-h-11 items-center justify-between gap-2">
                <span className="text-sm">Per-turn budget</span>
                {budgetControl}
              </div>
            </SheetPanel>
          </SheetPopup>
        </Sheet>
      ) : null}
    </div>
  );
}
