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
import {
  AttachmentChip,
  toAttachmentRef,
  type ConversationAttachmentRef,
  type PendingAttachment,
} from "./attachment-chip";
import { extractVideoFrames } from "./extract-video-frames";

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
  /** Attachments already uploaded (status: "done") at the time of queuing. */
  attachments: ConversationAttachmentRef[];
}

/** Monotonic counter for queued-message ids (stable, collision-free per mount). */
let queueIdCounter = 0;
function nextQueueId(): string {
  queueIdCounter += 1;
  return `q-${queueIdCounter}`;
}

/** Monotonic counter for locally-generated attachment ids (stable per mount). */
let attachmentIdCounter = 0;
function nextAttachmentId(): string {
  attachmentIdCounter += 1;
  return `att-${attachmentIdCounter}`;
}

/** Map a browser MIME type to an attachment kind, or null when unsupported. */
function attachmentKindFor(mimeType: string): "image" | "video" | "document" | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "document";
  return null;
}

/** Serialize completed attachments onto a FormData field the server actions parse. */
function setAttachmentsField(fd: FormData, attachments: ConversationAttachmentRef[]): void {
  if (attachments.length > 0) {
    fd.set("attachments", JSON.stringify(attachments));
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
  onInputHasContentChange,
  workspaceId,
}: {
  conversationId: string | null;
  parentMessageId: string | null;
  action: ComposerAction;
  disabled?: boolean;
  disabledReason?: string;
  modelConfig: ResolvedTierCatalog;
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
   * Workspace id used to authorize `/api/v1/upload/attachment`. Omit to hide
   * the attach affordance entirely (e.g. a host surface that only has slugs,
   * not a resolved workspace id, wired yet).
   */
  workspaceId?: string;
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

  // ── Attachments ──────────────────────────────────────────────────────────
  // Pending/uploaded attachments for the NEXT message to be sent. Uploaded
  // immediately on attach (see uploadAttachment) so the composer only ever
  // submits already-durable publicId refs — never inline bytes (the chat
  // stream body's 32 KiB content cap must never carry binary payloads).
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
  const attachmentsRef = React.useRef(attachments);
  React.useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  const inFlightUploadsRef = React.useRef<Map<string, XMLHttpRequest>>(new Map());
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const anyUploading = attachments.some((a) => a.status === "uploading");

  // Revoke any un-revoked local preview URLs on unmount (a still-uploading or
  // errored attachment's blob: URL would otherwise leak for the tab's life).
  React.useEffect(
    () => () => {
      for (const a of attachmentsRef.current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    },
    [],
  );

  const uploadAttachment = React.useCallback(
    (localId: string, file: File, kind: "image" | "video" | "document") => {
      if (!workspaceId) return;
      const fd = new FormData();
      fd.set("file", file);
      fd.set("kind", kind);
      fd.set("workspaceId", workspaceId);
      if (conversationIdRef.current) fd.set("conversationId", conversationIdRef.current);

      const xhr = new XMLHttpRequest();
      inFlightUploadsRef.current.set(localId, xhr);
      xhr.open("POST", "/api/v1/upload/attachment");
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const progress = Math.round((e.loaded / e.total) * 100);
        setAttachments((prev) =>
          prev.map((a) => (a.id === localId ? { ...a, progress } : a)),
        );
      };
      xhr.onload = () => {
        inFlightUploadsRef.current.delete(localId);
        const ok = xhr.status >= 200 && xhr.status < 300;
        let body: {
          publicId?: string;
          kind?: string;
          name?: string;
          mimeType?: string;
          url?: string;
          sizeBytes?: number;
          error?: string;
        } = {};
        try {
          body = JSON.parse(xhr.responseText) as typeof body;
        } catch {
          // Non-JSON body (e.g. an upstream 502 HTML page) — treat as failure below.
        }
        setAttachments((prev) =>
          prev.map((a) => {
            if (a.id !== localId) return a;
            if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
            if (!ok || !body.publicId || !body.url) {
              return {
                ...a,
                status: "error",
                error: body.error ?? `Upload failed (HTTP ${xhr.status})`,
                previewUrl: undefined,
              };
            }
            return {
              ...a,
              status: "done",
              progress: 100,
              publicId: body.publicId,
              url: body.url,
              mimeType: body.mimeType ?? a.mimeType,
              sizeBytes: body.sizeBytes,
              previewUrl: undefined,
            };
          }),
        );
      };
      xhr.onerror = () => {
        inFlightUploadsRef.current.delete(localId);
        setAttachments((prev) =>
          prev.map((a) => (a.id === localId ? { ...a, status: "error", error: "Network error" } : a)),
        );
      };
      xhr.onabort = () => {
        inFlightUploadsRef.current.delete(localId);
      };
      xhr.send(fd);
    },
    [workspaceId],
  );

  /**
   * Best-effort: for a video attachment, extract a handful of keyframes
   * in-browser and upload each as an ordinary "image" attachment, so a
   * non-Gemini model can still "see" a rough visual summary of the video (the
   * stream route only forwards raw video bytes when the resolved model
   * supports video input — see supportsVideoInput). Never blocks or fails the
   * video's own upload; extraction failures are silently skipped.
   */
  const extractAndUploadVideoFrames = React.useCallback(
    (file: File) => {
      if (!workspaceId) return;
      void extractVideoFrames(file).then((frames) => {
        for (const frame of frames) {
          const frameFile = new File(
            [frame.blob],
            `${file.name.replace(/\.[^.]+$/, "")}-frame-${Math.round(frame.atSeconds)}s.webp`,
            { type: frame.blob.type || "image/webp" },
          );
          const localId = nextAttachmentId();
          setAttachments((prev) => [
            ...prev,
            {
              id: localId,
              kind: "image",
              name: frameFile.name,
              mimeType: frameFile.type,
              status: "uploading",
              progress: 0,
            },
          ]);
          uploadAttachment(localId, frameFile, "image");
        }
      });
    },
    [workspaceId, uploadAttachment],
  );

  /** Attach one or more files: validate type, enqueue as "uploading", upload immediately. */
  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      if (!workspaceId) return;
      for (const file of Array.from(files)) {
        const kind = attachmentKindFor(file.type);
        const localId = nextAttachmentId();
        if (!kind) {
          setAttachments((prev) => [
            ...prev,
            {
              id: localId,
              kind: "document",
              name: file.name,
              mimeType: file.type,
              status: "error",
              error: "Unsupported file type",
            },
          ]);
          continue;
        }
        const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
        setAttachments((prev) => [
          ...prev,
          {
            id: localId,
            kind,
            name: file.name,
            mimeType: file.type,
            status: "uploading",
            progress: 0,
            previewUrl,
          },
        ]);
        uploadAttachment(localId, file, kind);
        if (kind === "video") extractAndUploadVideoFrames(file);
      }
    },
    [workspaceId, uploadAttachment, extractAndUploadVideoFrames],
  );

  const removeAttachment = React.useCallback((id: string) => {
    const xhr = inFlightUploadsRef.current.get(id);
    if (xhr) {
      xhr.abort();
      inFlightUploadsRef.current.delete(id);
    }
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const onPaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!workspaceId) return;
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) addFiles(imageFiles);
    },
    [workspaceId, addFiles],
  );

  const [isDraggingOver, setIsDraggingOver] = React.useState(false);
  const onDragOver = React.useCallback(
    (e: React.DragEvent<HTMLFormElement>) => {
      if (!workspaceId) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setIsDraggingOver(true);
    },
    [workspaceId],
  );
  const onDragLeave = React.useCallback(() => setIsDraggingOver(false), []);
  const onDrop = React.useCallback(
    (e: React.DragEvent<HTMLFormElement>) => {
      if (!workspaceId) return;
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      setIsDraggingOver(false);
      addFiles(e.dataTransfer.files);
    },
    [workspaceId, addFiles],
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
    attachmentRefs: ConversationAttachmentRef[],
  ): FormData {
    const fd = new FormData(form);
    if (conversationId) fd.set("conversationId", conversationId);
    if (parentMessageId) fd.set("parentMessageId", parentMessageId);
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
    setAttachmentsField(fd, attachmentRefs);
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

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (disabled || anyUploading) return;

    const contentRaw = (formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null)?.value ?? "";
    if (contentRaw.trim().length === 0) return;

    const readyAttachments = attachments.map(toAttachmentRef).filter((a): a is ConversationAttachmentRef => a !== null);

    // If a stream is in flight, honour the pending-prompt behavior.
    if (isStreaming && !pending) {
      if (pendingPromptBehavior === "interrupt") {
        // Abort the current stream, then submit immediately.
        onInterrupt?.();
        const fd = buildFormData(e.currentTarget, model, readyAttachments);
        formRef.current?.reset();
        setAttachments([]);
        dispatch(fd);
      } else {
        // queue mode: capture the message and model state; clear the textarea.
        const snapshot = model;
        const content = contentRaw;
        setQueue((prev) => [
          ...prev,
          { id: nextQueueId(), content, modelState: snapshot, attachments: readyAttachments },
        ]);
        setAttachments([]);
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

    const fd = buildFormData(e.currentTarget, model, readyAttachments);
    formRef.current?.reset();
    setAttachments([]);
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
      setAttachmentsField(fd, next.attachments);
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

    if (pending || disabled || anyUploading) return;

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

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring",
        isDraggingOver && "ring-2 ring-primary",
      )}
    >
      {/* Hidden file input driving the attach button; accepts the same kinds
          the composer's generate toggles produce (image/video) plus PDF
          documents. Cleared after each change so re-selecting the same file
          still fires onChange. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,application/pdf"
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <Textarea
        name="content"
        required
        placeholder={placeholder}
        rows={3}
        disabled={pending || disabled}
        onKeyDown={onKeyDown}
        onChange={handleTextareaChange}
        onPaste={onPaste}
        className="border-none bg-transparent shadow-none focus-visible:ring-0"
      />
      {/* Pending/uploaded attachment chips for the next message. */}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Attachments">
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

        {/* Attach file — hidden unless a workspaceId is available to authorize
            /api/v1/upload/attachment (e.g. the embedded floating panel, which
            only carries slugs today, has no attach affordance yet). */}
        {workspaceId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Attach file"
            disabled={pending || disabled}
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
            disabled={pending || disabled || anyUploading}
            size="sm"
            aria-label={
              anyUploading
                ? "Waiting for attachments to finish uploading"
                : isStreaming && pendingPromptBehavior === "interrupt"
                  ? "Interrupt and send"
                  : isStreaming
                    ? "Queue message"
                    : "Send message"
            }
            style={
              !pending && !disabled && !anyUploading
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
              : anyUploading
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
