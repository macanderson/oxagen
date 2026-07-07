"use client";
import * as React from "react";
import {
  Brain,
  ChevronDown,
  ChevronUp,
  Code2,
  ImageIcon,
  Paperclip,
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
import {
  supportsReasoning,
  getModel,
} from "@oxagen/ai/catalog";
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
import { ChatAgentToolbar } from "./chat-agent-toolbar";
import { ChatContextBar } from "./chat-context-bar";
import { SlashCommandMenu } from "./slash-command-menu";
// Import from the client-safe subpath, NOT the @oxagen/ai barrel: the barrel
// pulls telemetry/clickhouse/opentelemetry (async_hooks) into the client bundle
// and breaks the build. slash-commands.ts is dependency-free.
import { matchSlashCommands, type SlashCommand } from "@oxagen/ai/slash-commands";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import {
  pinStorageKey,
  readStoredPins,
  writeStoredPins,
  buildPinnedContext,
  DRAFT_PREFIX,
} from "./pinned-context";
import { MessageQueue } from "./message-queue";
import { AttachmentChip, hasInFlightUploads, type PendingAttachment } from "./attachment-chip";
import { extractVideoFrames } from "./extract-video-frames";

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

function toUploadedMeta(attachments: PendingAttachment[]): UploadedAttachmentMeta[] {
  // Map each video attachment's LOCAL id → its server publicId, so a keyframe
  // (which references the video by local id, created before the video finished
  // uploading) can be linked to the real publicId at submit time.
  const videoPublicIdByLocalId = new Map<string, string>();
  for (const a of attachments) {
    if (a.status === "uploaded" && a.kind === "video" && a.publicId) {
      videoPublicIdByLocalId.set(a.id, a.publicId);
    }
  }
  return attachments
    .filter(
      (a): a is PendingAttachment & Required<Pick<PendingAttachment, "publicId" | "kind" | "mimeType" | "url" | "name">> =>
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
        ? { keyframeForVideo: videoPublicIdByLocalId.get(a.keyframeForVideoLocalId)! }
        : {}),
    }));
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
  (formData: FormData): Promise<{
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
    window.localStorage.setItem(COMPOSER_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Private mode / storage quota — the preference just doesn't persist.
  }
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
  workspaceBudgetGovernance,
  onInputHasContentChange,
  orgSlug,
  workspaceSlug,
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
  /**
   * Workspace-level per-turn budget governance (OXA-2081), resolved
   * server-side via `workspace.budget.policy.read`. Null/omitted ⇒ no
   * governance — the composer behaves exactly as before this feature.
   */
  workspaceBudgetGovernance?: WorkspaceBudgetGovernance | null;
  /**
   * Called whenever the textarea transitions between empty and non-empty.
   * `true`  → user has typed content (hide suggested prompts).
   * `false` → input is empty / cleared (show suggested prompts).
   */
  onInputHasContentChange?: (hasContent: boolean) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  // Seed once at mount, applying any workspace budget governance (OXA-2081)
  // on top of the server-resolved default — a "default" governance pre-fills
  // an unset control, a "ceiling" clamps it. Lazy initializer: governance is
  // resolved server-side and doesn't change over the composer's lifetime.
  const [model, setModel] = React.useState<ComposerModelState>(() =>
    applyWorkspaceBudgetGovernance(
      initialModelState ?? defaultModelState,
      workspaceBudgetGovernance ?? null,
    ),
  );
  const [activeServerIds, setActiveServerIds] = React.useState<Set<string>>(new Set());

  // ── Code mode (OXA app-code-mode) ─────────────────────────────────────────
  // When on, a coding turn runs in a sandbox against a selected repo +
  // environment — both are REQUIRED before the send gate opens (see
  // `codeGateBlocked` below).
  const [codeMode, setCodeMode] = React.useState(false);
  const [selectedRepoKey, setSelectedRepoKey] = React.useState<string | null>(null);
  const [selectedEnvId, setSelectedEnvId] = React.useState<string | null>(null);
  const selectedRepo = availableRepos?.find((r) => r.key === selectedRepoKey) ?? null;
  const selectedEnv = availableEnvironments?.find((e) => e.id === selectedEnvId) ?? null;

  // Default the environment picker to the workspace default (isDefault) the
  // first time code mode is turned on with no environment chosen yet.
  React.useEffect(() => {
    if (!codeMode || selectedEnvId) return;
    const defaultEnv = availableEnvironments?.find((e) => e.isDefault);
    if (defaultEnv) setSelectedEnvId(defaultEnv.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-derive when codeMode flips on; availableEnvironments is stable per render from server props
  }, [codeMode]);

  const codeGateBlocked = codeMode && (!selectedRepo || !selectedEnvId);

  const formRef = React.useRef<HTMLFormElement>(null);

  // Collapsed state of the CODE-MODE agent toolbar (repo/env pickers) — wired
  // through to ChatAgentToolbar so the pickers can fold away once selected.
  const [agentToolbarCollapsed, setAgentToolbarCollapsed] = React.useState(false);

  // ── Responsive layout (mobile ≤767px) ──────────────────────────────────────
  const isMobile = useIsMobile();
  // Bottom sheet holding the overflow toolbar controls on phones.
  const [overflowOpen, setOverflowOpen] = React.useState(false);

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

  const expandComposer = React.useCallback(() => {
    setComposerCollapsed(false);
    persistComposerCollapsed(false);
    // The textarea is CSS-hidden while collapsed (so drafts survive) — focus
    // it on the frame after the expanded layout commits.
    requestAnimationFrame(() => {
      (formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null)?.focus();
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
  }, [pinKey]);

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
      writeStoredPins(pinKey, { repoKey: selectedRepoKey, envId: selectedEnvId });
    }
  }, [isPinned, pinKey, selectedRepoKey, selectedEnvId]);
  const handleSelectRepoKey = (key: string) => {
    setSelectedRepoKey(key);
    if (isPinned) writeStoredPins(pinKey, { repoKey: key, envId: selectedEnvId });
  };
  const handleSelectEnvId = (id: string) => {
    setSelectedEnvId(id);
    if (isPinned) writeStoredPins(pinKey, { repoKey: selectedRepoKey, envId: id });
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

  // Ref mirror of the code-mode + pin selection so dispatchQueued (queue-drain
  // path) reads the CURRENT selection at drain time, same pattern as
  // activeServerIdsRef/parentMessageIdRef below.
  const codeStateRef = React.useRef({
    codeMode,
    selectedRepo,
    selectedEnvId,
    isPinned,
    selectedEnv,
  });
  React.useEffect(() => {
    codeStateRef.current = { codeMode, selectedRepo, selectedEnvId, isPinned, selectedEnv };
  }, [codeMode, selectedRepo, selectedEnvId, isPinned, selectedEnv]);

  // Stable ref for the callback so the textarea onChange handler never
  // captures a stale closure — the identity of the ref never changes.
  const onInputHasContentChangeRef = React.useRef(onInputHasContentChange);
  React.useEffect(() => {
    onInputHasContentChangeRef.current = onInputHasContentChange;
  }, [onInputHasContentChange]);

  // Track whether the textarea currently has content so the parent can hide
  // the suggested-prompt chips while the user is typing.
  const inputHasContentRef = React.useRef(false);
  const handleTextareaChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const hasContent = value.length > 0;
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
    },
    [slashQuery],
  );

  // Apply a chosen slash command. Client-action commands (e.g. /pin) run
  // locally and clear the input; the rest insert "/<name> " so the user can
  // type args, then submit — the agent interprets the literal command.
  const applySlashCommand = React.useCallback(
    (command: SlashCommand) => {
      setSlashQuery(null);
      const ta = formRef.current?.elements.namedItem("content") as
        | HTMLTextAreaElement
        | null;
      if (command.clientAction === "pin") {
        if (ta) {
          ta.value = "";
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

  // Refs that always reflect the latest prop values so the queue-drain effect
  // (dep array [isStreaming]) reads the current parentMessageId / conversationId
  // rather than the stale closure captured when isStreaming last changed.
  const parentMessageIdRef = React.useRef(parentMessageId);
  React.useEffect(() => { parentMessageIdRef.current = parentMessageId; }, [parentMessageId]);
  const conversationIdRef = React.useRef(conversationId);
  React.useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  const activeServerIdsRef = React.useRef(activeServerIds);
  React.useEffect(() => { activeServerIdsRef.current = activeServerIds; }, [activeServerIds]);
  // Holds the id of the deferred-dispatch setTimeout so it can be cancelled on
  // unmount and before scheduling a new one.
  const dispatchTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(dispatchTimerRef.current), []);

  // FIFO queue for messages submitted while a stream is in flight (queue mode).
  const [queue, setQueue] = React.useState<QueuedMessage[]>([]);

  // ── Attachments (Phase 1: image-only) ─────────────────────────────────────
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
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
    (id: string, file: Blob, kind: "image" | "video", filename: string) => {
      const xhr = new XMLHttpRequest();
      xhrsRef.current.set(id, xhr);

      const fd = new FormData();
      fd.set("file", file, filename);
      fd.set("kind", kind);
      if (orgSlug) fd.set("orgSlug", orgSlug);
      if (workspaceSlug) fd.set("workspaceSlug", workspaceSlug);
      if (conversationIdRef.current) fd.set("conversationId", conversationIdRef.current);

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
        if (xhr.status >= 200 && xhr.status < 300 && parsed && typeof parsed === "object") {
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
            prev.map((a) => (a.id === id ? { ...a, status: "error", error: message } : a)),
          );
        }
      };

      xhr.onerror = () => {
        xhrsRef.current.delete(id);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id ? { ...a, status: "error", error: "Network error during upload" } : a,
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
      const frames = await extractVideoFrames(file, { maxFrames: VIDEO_KEYFRAME_COUNT });
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
      }));
      setAttachments((prev) => [...prev, ...keyframes]);
      queueMicrotask(() => {
        for (const kf of keyframes) uploadAttachment(kf.id, kf.file, "image", kf.file.name);
      });
    },
    [newLocalId, uploadAttachment],
  );

  /** Add newly picked/pasted/dropped files as pending attachments and start uploading each. */
  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files).filter(
        (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
      );
      if (incoming.length === 0) return;
      setAttachments((prev) => {
        // Only VISIBLE attachments count toward the strip cap; hidden keyframes
        // are added later out-of-band.
        const room = MAX_ATTACHMENTS - prev.filter((a) => !a.hidden).length;
        if (room <= 0) return prev;
        const accepted = incoming.slice(0, room);
        const next: PendingAttachment[] = accepted.map((file) => ({
          id: newLocalId(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: "uploading",
          progress: 0,
        }));
        // Kick off uploads outside the updater (setState updaters must stay
        // pure) — deferred via microtask so this runs after the state commits.
        queueMicrotask(() => {
          for (const a of next) {
            const isVideo = a.file.type.startsWith("video/");
            uploadAttachment(a.id, a.file, isVideo ? "video" : "image", a.file.name);
            if (isVideo) void attachVideoKeyframes(a.id, a.file);
          }
        });
        return [...prev, ...next];
      });
    },
    [attachVideoKeyframes, newLocalId, uploadAttachment],
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

  // Placeholder text varies by media mode.
  const placeholder =
    disabled
      ? (disabledReason ?? "Composer paused.")
      : model.generate === "image"
        ? "Describe the image you want…"
        : model.generate === "video"
          ? "Describe the video you want…"
          : "Send a message…";

  function toggleGenerate(kind: "image" | "video") {
    if (model.generate === kind) {
      // Toggle off — return to text defaults.
      setModel((s) => ({ ...s, generate: null, mediaTier: "basic", mediaModel: null }));
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
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (disabled) return;
    // Code mode requires BOTH a repo and an environment before the first
    // coding turn — the submit button is disabled for this too, but guard
    // here as well since Enter/Cmd+Enter bypass the button.
    if (codeGateBlocked) return;
    // Never submit while an upload is still in flight — the model would
    // otherwise resolve an attachment the server hasn't finished persisting.
    if (hasInFlightUploads(attachments)) return;

    const contentRaw = (formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null)?.value ?? "";
    if (contentRaw.trim().length === 0) return;

    const attachmentsSnapshot = toUploadedMeta(attachments);

    // If a stream is in flight, honour the pending-prompt behavior.
    if (isStreaming && !pending) {
      if (pendingPromptBehavior === "interrupt") {
        // Abort the current stream, then submit immediately.
        onInterrupt?.();
        const fd = buildFormData(e.currentTarget, model, attachmentsSnapshot);
        formRef.current?.reset();
        clearAttachments();
        dispatch(fd);
      } else {
        // queue mode: capture the message, model state, and attachments; clear
        // the textarea + pending strip.
        const snapshot = model;
        const content = contentRaw;
        setQueue((prev) => [
          ...prev,
          { id: nextQueueId(), content, modelState: snapshot, attachments: attachmentsSnapshot },
        ]);
        clearAttachments();
        (formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null)?.dispatchEvent(new Event("input"));
        // Reset the native textarea value directly so the placeholder reappears.
        const ta = formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null;
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
      if (currentConversationId) fd.set("conversationId", currentConversationId);
      if (currentParentMessageId) fd.set("parentMessageId", currentParentMessageId);
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
      const code = codePayload(currentCode.codeMode, currentCode.selectedRepo, currentCode.selectedEnv);
      if (code) fd.set("code", JSON.stringify(code));
      if (currentCode.isPinned && !currentCode.codeMode) {
        const pinned = buildPinnedContext(currentCode.selectedRepo, currentCode.selectedEnv);
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
  const reorderQueued = React.useCallback((index: number, direction: "up" | "down") => {
    setQueue((prev) => {
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      if (!moved) return prev;
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

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
        setSlashActiveIndex((i) => (i - 1 + slashCommands.length) % slashCommands.length);
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

    const isEmpty =
      (e.currentTarget.value ?? "").trim().length === 0;
    if (isEmpty) {
      // Suppress empty-submit in all modes; allow newline via default.
      if (enterToSubmit && !e.shiftKey) e.preventDefault();
      return;
    }

    if (pending || disabled || codeGateBlocked) return;

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
  // The persistent pin context bar shows whenever there's something to pin and
  // code mode isn't taking over the selectors (the two share selection state
  // and render mutually exclusively).
  const showContextBar = !codeMode && (hasRepos || hasEnvironments);

  // Shared between the desktop toolbar row and the mobile overflow sheet —
  // exactly one of the two renders at a time (see `isMobile` branches below).
  const effortSelect = (
    <Select
      value={model.effort ?? "medium"}
      onValueChange={(v) => setModel((s) => ({ ...s, effort: v as EffortLevel }))}
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

  return (
    <div className="flex flex-col">
      {/* Code-mode agent toolbar (sandbox coding turn) OR the persistent pin
          context bar. Both drive the same selection state and render mutually
          exclusively so there's never a duplicate repo/env selector. Hidden
          entirely while the composer is collapsed. */}
      {!composerCollapsed &&
        (codeMode ? (
          <ChatAgentToolbar
            repositories={availableRepos ?? []}
            environments={availableEnvironments ?? []}
            selectedRepoKey={selectedRepoKey}
            selectedEnvId={selectedEnvId}
            onSelectRepo={(repo) => handleSelectRepoKey(repo.key)}
            onSelectEnv={handleSelectEnvId}
            isCollapsed={agentToolbarCollapsed}
            onToggleCollapse={setAgentToolbarCollapsed}
          />
        ) : showContextBar ? (
          <ChatContextBar
            repositories={availableRepos ?? []}
            environments={availableEnvironments ?? []}
            selectedRepoKey={selectedRepoKey}
            selectedEnvId={selectedEnvId}
            onSelectRepo={(repo) => handleSelectRepoKey(repo.key)}
            onSelectEnv={handleSelectEnvId}
            isPinned={isPinned}
            onTogglePin={togglePin}
            disabled={pending || disabled}
          />
        ) : null)}
      <form
        ref={formRef}
        onSubmit={onSubmit}
        onDragOver={canAttach ? handleDragOver : undefined}
        onDragLeave={canAttach ? handleDragLeave : undefined}
        onDrop={canAttach ? handleDrop : undefined}
        className={cn(
          "flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring",
          (codeMode || showContextBar) && !composerCollapsed && "rounded-t-none",
          composerCollapsed && "gap-0 py-1.5",
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
          form's `content` field survive collapse/expand round-trips. */}
      <div className="relative">
        {slashOpen ? (
          <SlashCommandMenu
            commands={slashCommands}
            activeIndex={slashActiveIndex}
            onSelect={applySlashCommand}
            onHoverIndex={setSlashActiveIndex}
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
          onBlur={() => setSlashQuery(null)}
          onPaste={canAttach ? handlePaste : undefined}
          className={cn(
            "border-none bg-transparent shadow-none focus-visible:ring-0",
            composerCollapsed && "hidden",
          )}
        />
      </div>
      {/* Pending attachment strip — thumbnails with upload progress/remove.
          Hidden video keyframes are excluded (they ride with their video). */}
      {visibleAttachments.length > 0 && !composerCollapsed ? (
        <div className="flex flex-wrap gap-2" data-testid="attachment-strip">
          {visibleAttachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onRemove={removeAttachment} />
          ))}
        </div>
      ) : null}
      {/* Queued messages (queue mode): ordered list with reorder / edit /
          remove / send-now controls. */}
      {!composerCollapsed && (
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
      {codeGateBlocked && !composerCollapsed ? (
        <p className="text-xs text-muted-foreground" data-testid="code-mode-gate-hint">
          Select a repository and environment to start coding.
        </p>
      ) : null}

      {/* Toolbar. Collapsed: a slim single row (~40px) with a tap-to-expand
          affordance, the send button, and the expand chevron. Expanded on
          desktop: the full control row (flex-wrap as an overflow safety net).
          Expanded on mobile: only the essentials inline (attach, code mode,
          send) — everything else lives in the bottom overflow sheet. */}
      <div className={cn("flex items-center gap-1", !composerCollapsed && "flex-wrap")}>
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
            {/* Model picker + reasoning effort — inline on desktop, in the
                overflow sheet on mobile. */}
            {!isMobile && (
              <>
                <ModelPicker value={model} onChange={setModel} modelConfig={modelConfig} />
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
                disabled={pending || disabled || visibleAttachments.length >= MAX_ATTACHMENTS}
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
                    model.generate === "image" && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
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
                    model.generate === "video" && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
                  )}
                >
                  <Video className="h-4 w-4" />
                </Button>
              </>
            )}

            {/* Code mode toggle — routes the turn to a sandboxed coding agent
                against the selected repo + environment (see ChatAgentToolbar
                above). Requires both selections before send unblocks.
                Essential — always inline. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Toggle code mode"
              aria-pressed={codeMode}
              disabled={!hasRepos && !codeMode}
              title={!hasRepos && !codeMode ? "Connect a GitHub repository to use code mode" : undefined}
              onClick={() => setCodeMode((v) => !v)}
              className={cn(
                "p-0",
                isMobile ? "h-11 w-11" : "h-8 w-8",
                codeMode && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
              )}
            >
              <Code2 className="h-4 w-4" />
            </Button>

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
            disabled={pending || disabled || uploadsInFlight || codeGateBlocked}
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
              !pending && !disabled && !uploadsInFlight && !codeGateBlocked
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
            aria-label={composerCollapsed ? "Expand composer" : "Collapse composer"}
            aria-expanded={!composerCollapsed}
            data-testid="composer-collapse-toggle"
            onClick={composerCollapsed ? expandComposer : collapseComposer}
            className={cn("p-0", isMobile && !composerCollapsed ? "h-11 w-11" : "h-8 w-8")}
          >
            {composerCollapsed ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </form>

    {/* Mobile overflow sheet: the non-essential toolbar controls as
        thumb-friendly full-width rows (≥44px tall). Portaled to the body, so
        interactive children here are OUTSIDE the form — every control is a
        type="button"/stateful picker, never a submit. */}
    {isMobile && !composerCollapsed ? (
      <Sheet open={overflowOpen} onOpenChange={setOverflowOpen}>
        <SheetPopup
          side="bottom"
          data-testid="composer-overflow-sheet"
          className="max-h-[70vh] rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="mb-2">
            <SheetTitle className="text-sm">Composer options</SheetTitle>
            <SheetDescription className="sr-only">
              Model, generation, MCP server, and budget controls for this turn.
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="gap-1">
            <div className="flex min-h-11 items-center justify-between gap-2">
              <span className="text-sm">Model</span>
              <ModelPicker value={model} onChange={setModel} modelConfig={modelConfig} />
            </div>
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
                model.generate === "image" && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
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
                model.generate === "video" && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
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
