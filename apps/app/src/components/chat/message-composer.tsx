"use client";
import * as React from "react";
import { Brain, ImageIcon, Paperclip, Send, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  supportsReasoning,
  getModel,
} from "@oxagen/ai/catalog";
import type { ResolvedTierCatalog, EffortLevel } from "@oxagen/ai/catalog";
import {
  ModelPicker,
  defaultModelState,
  type ComposerModelState,
} from "./model-picker";
import type { McpServerSummary } from "./mcp-types";
import { McpServerPicker } from "./mcp-server-picker";
import { MessageQueue } from "./message-queue";
import { AttachmentChip, hasInFlightUploads, type PendingAttachment } from "./attachment-chip";

/** Only image attachments are wired to the composer in Phase 1 (video/PDF
 * attach UI is deferred — see the multimodal blueprint Phase 2). */
const ATTACHMENT_ACCEPT = "image/*";
/** Bounds a single turn's attachment count — mirrors the stream route's
 * `attachments` array cap (BodySchema `.max(8)`). */
const MAX_ATTACHMENTS = 8;

/** The serializable subset of an uploaded attachment sent to the server —
 * mirrors `conversationAssetItem` minus fields the composer never needs. */
export interface UploadedAttachmentMeta {
  publicId: string;
  kind: string;
  name: string;
  mimeType: string;
  url: string;
}

function toUploadedMeta(attachments: PendingAttachment[]): UploadedAttachmentMeta[] {
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
    .map((a) => ({ publicId: a.publicId, kind: a.kind, name: a.name, mimeType: a.mimeType, url: a.url }));
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
  /**
   * Called whenever the textarea transitions between empty and non-empty.
   * `true`  → user has typed content (hide suggested prompts).
   * `false` → input is empty / cleared (show suggested prompts).
   */
  onInputHasContentChange?: (hasContent: boolean) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<ComposerModelState>(
    initialModelState ?? defaultModelState,
  );
  const [activeServerIds, setActiveServerIds] = React.useState<Set<string>>(new Set());
  const formRef = React.useRef<HTMLFormElement>(null);

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
      const hasContent = e.target.value.length > 0;
      if (hasContent !== inputHasContentRef.current) {
        inputHasContentRef.current = hasContent;
        onInputHasContentChangeRef.current?.(hasContent);
      }
    },
    [],
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
    (id: string, file: File) => {
      const xhr = new XMLHttpRequest();
      xhrsRef.current.set(id, xhr);

      const fd = new FormData();
      fd.set("file", file);
      fd.set("kind", "image");
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

  /** Add newly picked/pasted/dropped files as pending attachments and start uploading each. */
  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (incoming.length === 0) return;
      setAttachments((prev) => {
        const room = MAX_ATTACHMENTS - prev.length;
        if (room <= 0) return prev;
        const accepted = incoming.slice(0, room);
        const next: PendingAttachment[] = accepted.map((file) => ({
          id:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          previewUrl: URL.createObjectURL(file),
          status: "uploading",
          progress: 0,
        }));
        // Kick off uploads outside the updater (setState updaters must stay
        // pure) — deferred via microtask so this runs after the state commits.
        queueMicrotask(() => {
          for (const a of next) uploadAttachment(a.id, a.file);
        });
        return [...prev, ...next];
      });
    },
    [uploadAttachment],
  );

  const removeAttachment = React.useCallback((id: string) => {
    xhrsRef.current.get(id)?.abort();
    xhrsRef.current.delete(id);
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    // Reset so selecting the SAME file again still fires onChange.
    e.target.value = "";
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
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

    const isEnter = e.key === "Enter";
    if (!isEnter) return;

    const isEmpty =
      (e.currentTarget.value ?? "").trim().length === 0;
    if (isEmpty) {
      // Suppress empty-submit in all modes; allow newline via default.
      if (enterToSubmit && !e.shiftKey) e.preventDefault();
      return;
    }

    if (pending || disabled) return;

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
  // Without a resolved org+workspace scope the upload endpoint's membership
  // guard can't run — degrade to a text-only composer rather than uploading
  // with a malformed request.
  const canAttach = Boolean(orgSlug) && Boolean(workspaceSlug);

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onDragOver={canAttach ? handleDragOver : undefined}
      onDragLeave={canAttach ? handleDragLeave : undefined}
      onDrop={canAttach ? handleDrop : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring",
        isDragOver && "ring-2 ring-primary",
      )}
    >
      {/* Hidden native file input — triggered by the paperclip button. Phase 1
          accepts images only; video/PDF attach UI is a later phase. */}
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
      <Textarea
        name="content"
        required
        placeholder={placeholder}
        rows={3}
        disabled={pending || disabled}
        onKeyDown={onKeyDown}
        onChange={handleTextareaChange}
        onPaste={canAttach ? handlePaste : undefined}
        className="border-none bg-transparent shadow-none focus-visible:ring-0"
      />
      {/* Pending attachment strip — thumbnails with upload progress/remove. */}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2" data-testid="attachment-strip">
          {attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onRemove={removeAttachment} />
          ))}
        </div>
      ) : null}
      {/* Queued messages (queue mode): ordered list with reorder / edit /
          remove / send-now controls. */}
      <MessageQueue
        items={queue.map((q) => ({ id: q.id, content: q.content }))}
        isStreaming={isStreaming}
        onRemove={removeQueued}
        onReorder={reorderQueued}
        onEdit={editQueued}
        onSendNow={sendQueuedNow}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {disabled && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center gap-1">
        {/* Model picker */}
        <ModelPicker value={model} onChange={setModel} modelConfig={modelConfig} />

        {/* Reasoning effort — only when the resolved model supports it */}
        {showEffortControl && (
          <Select
            value={model.effort ?? "medium"}
            onValueChange={(v) => setModel((s) => ({ ...s, effort: v as EffortLevel }))}
          >
            <SelectTrigger
              size="sm"
              className="h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-muted focus:ring-0"
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
        )}

        {/* Attach image — opens the native file picker; paste/drag-drop also work. */}
        {canAttach ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Attach image"
            disabled={pending || disabled || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
            className="h-8 w-8 p-0"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
        ) : null}

        {/* Image generation toggle */}
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

        {/* Video generation toggle */}
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

        {/* MCP server activation picker — only shown when servers are available */}
        {(availableMcpServers?.length ?? 0) > 0 && (
          <McpServerPicker
            servers={availableMcpServers!}
            activeServerIds={activeServerIds}
            onActiveServerIdsChange={setActiveServerIds}
          />
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
            disabled={pending || disabled || uploadsInFlight}
            size="sm"
            aria-label={
              isStreaming && pendingPromptBehavior === "interrupt"
                ? "Interrupt and send"
                : isStreaming
                  ? "Queue message"
                  : "Send message"
            }
            style={
              !pending && !disabled && !uploadsInFlight
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
        </div>
      </div>
    </form>
  );
}
