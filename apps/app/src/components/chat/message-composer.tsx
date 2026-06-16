"use client";
import * as React from "react";
import { Brain, ImageIcon, Send, Video } from "lucide-react";
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
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<ComposerModelState>(
    initialModelState ?? defaultModelState,
  );
  const [activeServerIds, setActiveServerIds] = React.useState<Set<string>>(new Set());
  const formRef = React.useRef<HTMLFormElement>(null);

  // Refs that always reflect the latest prop values so the queue-drain effect
  // (dep array [isStreaming]) reads the current parentMessageId / conversationId
  // rather than the stale closure captured when isStreaming last changed.
  const parentMessageIdRef = React.useRef(parentMessageId);
  React.useEffect(() => { parentMessageIdRef.current = parentMessageId; }, [parentMessageId]);
  const conversationIdRef = React.useRef(conversationId);
  React.useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  const activeServerIdsRef = React.useRef(activeServerIds);
  React.useEffect(() => { activeServerIdsRef.current = activeServerIds; }, [activeServerIds]);

  // FIFO queue for messages submitted while a stream is in flight (queue mode).
  const [queue, setQueue] = React.useState<QueuedMessage[]>([]);

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
    if (disabled) return;

    const contentRaw = (formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null)?.value ?? "";
    if (contentRaw.trim().length === 0) return;

    // If a stream is in flight, honour the pending-prompt behavior.
    if (isStreaming && !pending) {
      if (pendingPromptBehavior === "interrupt") {
        // Abort the current stream, then submit immediately.
        onInterrupt?.();
        const fd = buildFormData(e.currentTarget, model);
        formRef.current?.reset();
        dispatch(fd);
      } else {
        // queue mode: capture the message and model state; clear the textarea.
        const snapshot = model;
        const content = contentRaw;
        setQueue((prev) => [...prev, { id: nextQueueId(), content, modelState: snapshot }]);
        (formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null)?.dispatchEvent(new Event("input"));
        // Reset the native textarea value directly so the placeholder reappears.
        const ta = formRef.current?.elements.namedItem("content") as HTMLTextAreaElement | null;
        if (ta) ta.value = "";
      }
      return;
    }

    const fd = buildFormData(e.currentTarget, model);
    formRef.current?.reset();
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
      // Defer the dispatch out of the caller (effect / event handler) so the
      // queue-drain doesn't cascade synchronously within a React effect
      // (satisfies react-hooks/set-state-in-effect) and so send-now doesn't
      // start a transition inside an unrelated render.
      setTimeout(() => dispatch(fd), 0);
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

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring"
    >
      <Textarea
        name="content"
        required
        placeholder={placeholder}
        rows={3}
        disabled={pending || disabled}
        onKeyDown={onKeyDown}
        className="border-none bg-transparent shadow-none focus-visible:ring-0"
      />
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
            disabled={pending || disabled}
            size="sm"
            aria-label={
              isStreaming && pendingPromptBehavior === "interrupt"
                ? "Interrupt and send"
                : isStreaming
                  ? "Queue message"
                  : "Send message"
            }
            style={
              !pending && !disabled
                ? {
                    background: "var(--grad-sunset)",
                    boxShadow: "var(--glow-violet)",
                    border: "none",
                    color: "#ffffff",
                  }
                : undefined
            }
          >
            <Send className="h-3.5 w-3.5" />
            {pending
              ? "Sending…"
              : isStreaming && pendingPromptBehavior === "interrupt"
                ? "Interrupt"
                : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}
