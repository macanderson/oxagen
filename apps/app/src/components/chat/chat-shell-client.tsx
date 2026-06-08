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
import { ToolCallCard } from "./tool-call-card";
import { CodeExecuteCard } from "./code-execute-card";
import { MemoryCard } from "./memory-card";
import { SubagentFanout } from "./subagent-fanout";
import { CHAT_COMPONENTS, logUnknownComponent } from "./chat-component-registry";
import { StreamingText } from "./streaming-text";
import { ReasoningCard } from "./reasoning-card";
import { ActivityTimeline, TimelineItem } from "./activity-timeline";
import { useToolStream } from "./use-tool-stream";
import type { ChatShellProps } from "./chat-shell";
import type { StreamEvent } from "./stream-event-types";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import type { ComposerModelState } from "./model-picker";
import { SuggestedPromptChips } from "./suggested-prompt-chips";
import { ConversationFiles } from "./conversation-files";
import { useLatestRef } from "@/lib/use-latest-ref";

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
  resolvePlanAction,
  agentCapabilities,
  orgSlug,
  workspaceSlug,
  modelConfig,
  enterToSubmit = false,
  pendingPromptBehavior = "queue",
  initialModelState,
}: {
  conversationId: string | null;
  /** publicId used for the files-panel fetch. */
  conversationPublicId: string | null;
  activeLeafMessageId: string | null;
  messages: ChatMessage[];
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
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
}) {
  const {
    plans,
    pendingApprovals,
    toolCalls,
    reasonings,
    steps,
    textSegments,
    memoryRecalls,
    memoryWrites,
    activeFanouts,
    components: liveComponents,
    order,
    turnUsage,
    consume,
    reset,
    hasBlockingApproval,
    signalApprovalResolved,
  } = useToolStream();

  const router = useRouter();
  const pathname = usePathname();

  // Track whether the current turn is streaming (to show live events).
  const [isStreaming, setIsStreaming] = React.useState(false);
  const isStreamingValueRef = useLatestRef(isStreaming);

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
  }, [messages, reset]);

  // Stable refs so useCallback deps don't change on every render.
  const consumeRef = useLatestRef(consume);
  const resetRef = useLatestRef(reset);
  const signalRef = useLatestRef(signalApprovalResolved);
  const orgSlugRef = useLatestRef(orgSlug);
  const workspaceSlugRef = useLatestRef(workspaceSlug);
  const setIsStreamingRef = useLatestRef(setIsStreaming);

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
  const hasPendingApproval = hasPersistentPendingApproval || hasBlockingApproval;

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
    [resolveApprovalAction],
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
      setIsStreamingRef.current(true);

      const wasNewConversation = !conversationIdRef.current;
      const result = await sendAction(formData);
      if (!result.ok || !result.conversationId) {
        // Persistence failed (or yielded no conversation): don't stream; the
        // result drives the composer's error state.
        setIsStreamingRef.current(false);
        return result;
      }

      // If this turn created the conversation, pin the browser URL to its
      // public id. Without `?c=<publicId>` the bare /ask|/chat URL resolves to
      // a blank slate, so the new conversation's persisted history would never
      // render (and the next turn would spawn yet another conversation).
      // Also trigger an immediate router.refresh() so the conversation nav list
      // updates right away (shows the new conversation) without waiting for the
      // stream to finish — the DB row exists as soon as sendAction returns.
      if (wasNewConversation && result.conversationPublicId) {
        router.replace(`${pathname}?c=${result.conversationPublicId}`);
        router.refresh();
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
            }),
          });

          if (!res.ok || !res.body) {
            setIsStreamingRef.current(false);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();

          await consumeRef.current(sseToEvents(reader, decoder, signal));

          // Turn finished cleanly: pull the now-persisted assistant reply into
          // the RSC `messages` prop. The [messages] effect above then clears
          // the live state once the refreshed prop lands, so the reply becomes
          // a durable persisted bubble instead of vanishing on the next submit.
          if (abortControllerRef.current === controller) {
            awaitingReconcileRef.current = true;
            router.refresh();
          }
        } catch (err) {
          // AbortError is expected on interrupt or unmount — not a warning.
          if (err instanceof Error && err.name !== "AbortError") {
            // Swallow — the RSC revalidate will still show the persisted reply.
            console.warn("[chat] stream fetch failed", err);
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
    [sendAction, router, pathname],
  );

  // Called by the composer when the user wants to interrupt the in-flight stream.
  const handleInterrupt = React.useCallback(() => {
    abortControllerRef.current?.abort();
    // Reset live state immediately so the partial turn is cleaned up.
    resetRef.current();
    setIsStreamingRef.current(false);
  }, []);

  const callbacks: MessageBubbleCallbacks = {
    onResolveApproval: wrappedResolveApproval,
    onResolvePlan: resolvePlanAction,
    agentCapabilities,
    onNavigateToChild: (childMessageId) => {
      if (typeof window !== "undefined") {
        window.location.hash = `m-${childMessageId}`;
      }
    },
  };

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
                  weight: w.weight,
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
          logUnknownComponent(lc.componentId);
          return null;
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
      {/* Toolbar row: files panel trigger (right-aligned). */}
      <div className="flex shrink-0 items-center justify-end">
        <ConversationFiles conversationPublicId={conversationPublicId} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
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
            <MessageTree messages={messages} callbacks={callbacks} />
            {/* Live turn: the ordered chain of thought/action, rendered as a
                connected timeline before the RSC revalidate replaces it with
                the persisted message. */}
            {hasLiveContent ? (
              <div data-live-turn>
                <ActivityTimeline>
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
                  <div className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
                    {turnUsage.totalTokens.toLocaleString()} tokens
                    {turnUsage.creditsCharged !== undefined
                      ? ` · ${turnUsage.creditsCharged} credit${turnUsage.creditsCharged === 1 ? "" : "s"}`
                      : null}
                  </div>
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
        <span className="text-[#7182ff]">·  working</span>
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
