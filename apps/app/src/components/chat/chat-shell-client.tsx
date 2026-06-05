"use client";
import * as React from "react";
import { Suspense } from "react";
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
import { useToolStream } from "./use-tool-stream";
import type { ChatShellProps } from "./chat-shell";
import type { StreamEvent } from "./stream-event-types";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";

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
  activeLeafMessageId,
  messages,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
  agentCapabilities,
  orgSlug,
  workspaceSlug,
}: {
  conversationId: string | null;
  activeLeafMessageId: string | null;
  messages: ChatMessage[];
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
  agentCapabilities?: ChatShellProps["agentCapabilities"];
  orgSlug: string;
  workspaceSlug: string;
}) {
  const {
    plans,
    pendingApprovals,
    toolCalls,
    memoryRecalls,
    memoryWrites,
    activeFanouts,
    components: liveComponents,
    messages: liveMessages,
    turnUsage,
    consume,
    reset,
    hasBlockingApproval,
    signalApprovalResolved,
  } = useToolStream();

  // Track whether the current turn is streaming (to show live events).
  const [isStreaming, setIsStreaming] = React.useState(false);

  // Stable refs so useCallback deps don't change on every render.
  const consumeRef = React.useRef(consume);
  const resetRef = React.useRef(reset);
  const signalRef = React.useRef(signalApprovalResolved);
  React.useEffect(() => { consumeRef.current = consume; }, [consume]);
  React.useEffect(() => { resetRef.current = reset; }, [reset]);
  React.useEffect(() => { signalRef.current = signalApprovalResolved; }, [signalApprovalResolved]);

  const orgSlugRef = React.useRef(orgSlug);
  const workspaceSlugRef = React.useRef(workspaceSlug);
  React.useEffect(() => { orgSlugRef.current = orgSlug; }, [orgSlug]);
  React.useEffect(() => { workspaceSlugRef.current = workspaceSlug; }, [workspaceSlug]);

  const setIsStreamingRef = React.useRef(setIsStreaming);

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

      const result = await sendAction(formData);
      if (!result.ok || !result.conversationId) {
        // Persistence failed (or yielded no conversation): don't stream; the
        // result drives the composer's error state.
        setIsStreamingRef.current(false);
        return result;
      }

      void (async () => {
        try {
          const res = await fetch("/api/v1/chat/stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content,
              conversationId: result.conversationId,
              parentMessageId: result.userMessageId ?? null,
              orgSlug: orgSlugRef.current,
              workspaceSlug: workspaceSlugRef.current,
            }),
          });

          if (!res.ok || !res.body) {
            setIsStreamingRef.current(false);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();

          await consumeRef.current(sseToEvents(reader, decoder));
        } catch (err) {
          // Swallow — the RSC revalidate will still show the persisted reply.
          console.warn("[chat] stream fetch failed", err);
        } finally {
          setIsStreamingRef.current(false);
        }
      })();

      return result;
    },
    [sendAction],
  );

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

  // Partition live tool calls: agent.code.execute renders as CodeExecuteCard;
  // all others render as ToolCallCard.
  const codeExecuteToolCalls = Object.values(toolCalls).filter(
    (tc) => tc.capability === "agent.code.execute",
  );
  const genericToolCalls = Object.values(toolCalls).filter(
    (tc) => tc.capability !== "agent.code.execute",
  );

  const livePlans = Object.values(plans);
  const liveApprovals = Object.values(pendingApprovals);
  const liveMemoryRecalls = Object.values(memoryRecalls);
  const liveMemoryWritesList = Object.values(memoryWrites);
  const liveFanouts = Object.values(activeFanouts);
  const liveTextMessages = Object.values(liveMessages);
  const liveComponentList = Object.values(liveComponents);
  const hasLiveContent =
    isStreaming ||
    livePlans.length > 0 ||
    liveApprovals.length > 0 ||
    genericToolCalls.length > 0 ||
    codeExecuteToolCalls.length > 0 ||
    liveMemoryRecalls.length > 0 ||
    liveMemoryWritesList.length > 0 ||
    liveFanouts.length > 0 ||
    liveTextMessages.length > 0 ||
    liveComponentList.length > 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4">
      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
        {messages.length === 0 && !hasLiveContent ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <p className="font-medium">Start a conversation.</p>
            <p>Send a message below to begin.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <MessageTree messages={messages} callbacks={callbacks} />
            {/* Live turn: stream events rendered before the RSC revalidate. */}
            {hasLiveContent ? (
              <div className="flex flex-col gap-2" data-live-turn>
                {livePlans.map((plan) => (
                  <PlanCard
                    key={plan.planId}
                    planId={plan.planId}
                    title={plan.title}
                    steps={plan.steps}
                    rationale={plan.rationale}
                    status={plan.status}
                    agentCapabilities={agentCapabilities}
                    onResolve={resolvePlanAction}
                  />
                ))}
                {liveApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.approvalId}
                    approvalId={approval.approvalId}
                    capability={approval.capability}
                    inputPreview={approval.inputPreview}
                    riskLevel={approval.riskLevel}
                    expiresAt={approval.expiresAt}
                    resolution={approval.resolution}
                    onResolved={wrappedResolveApproval}
                  />
                ))}
                {genericToolCalls.map((tc) => (
                  <ToolCallCard
                    key={tc.toolCallId}
                    toolCallId={tc.toolCallId}
                    capability={tc.capability}
                    inputPreview={tc.inputPreview}
                    riskLevel={tc.riskLevel}
                    status={tc.status}
                    output={tc.output}
                    stdout={tc.stdout}
                    stderr={tc.stderr}
                    errorReason={tc.errorReason}
                    durationMs={tc.durationMs}
                  />
                ))}
                {liveMemoryRecalls.map((mr) => (
                  <MemoryCard
                    key={mr.queryId}
                    queryId={mr.queryId}
                    memories={mr.memories}
                  />
                ))}
                {codeExecuteToolCalls.map((tc) => {
                  const preview = tc.inputPreview as Record<string, unknown> | null ?? {};
                  const language = typeof preview.language === "string" ? preview.language : "node";
                  const code = typeof preview.code === "string" ? preview.code : "";
                  const outputRecord = tc.output as Record<string, unknown> | null ?? {};
                  const exitCode = typeof outputRecord.exitCode === "number" ? outputRecord.exitCode : undefined;
                  return (
                    <CodeExecuteCard
                      key={tc.toolCallId}
                      toolCallId={tc.toolCallId}
                      language={language}
                      code={code}
                      status={tc.status}
                      stdout={tc.stdout}
                      stderr={tc.stderr}
                      exitCode={exitCode}
                      durationMs={tc.durationMs}
                    />
                  );
                })}
                {liveFanouts.map((fanout) => (
                  <SubagentFanout
                    key={fanout.fanoutId}
                    fanoutId={fanout.fanoutId}
                    parentMessageId={fanout.parentMessageId}
                    subagents={fanout.children}
                    status={fanout.status}
                    results={fanout.results}
                    onSelectChild={callbacks.onNavigateToChild}
                  />
                ))}
                {liveMemoryWritesList.map((write) => (
                  <MemoryCard
                    key={write.memoryId}
                    queryId={write.memoryId}
                    memories={[
                      {
                        id: write.memoryId,
                        lesson: `Memory written → ${write.nodeRef}`,
                        weight: write.weight,
                        score: 1,
                        nodeRef: write.nodeRef,
                      },
                    ]}
                  />
                ))}
                {liveTextMessages.map((msg) =>
                  msg.text ? (
                    <div
                      key={msg.messageId}
                      className="whitespace-pre-wrap leading-relaxed text-sm"
                    >
                      {msg.text}
                    </div>
                  ) : null,
                )}
                {liveComponentList.map((lc) => {
                  const Component = CHAT_COMPONENTS[lc.componentId];
                  if (!Component) {
                    logUnknownComponent(lc.componentId);
                    return null;
                  }
                  return (
                    <Suspense
                      key={lc.toolCallId}
                      fallback={
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
                      }
                    >
                      <Component {...lc.props} />
                    </Suspense>
                  );
                })}
                {turnUsage !== undefined ? (
                  <div className="text-xs text-muted-foreground text-right tabular-nums">
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
      <MessageComposer
        conversationId={conversationId}
        parentMessageId={activeLeafMessageId}
        action={wrappedSendAction}
        disabled={hasPendingApproval}
      />
    </div>
  );
}

// Parse a ReadableStream of raw SSE bytes into an async iterable of
// StreamEvent objects. Handles partial-line buffering across read() calls
// and emits each event when `data: [DONE]` is NOT reached.
async function* sseToEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): AsyncGenerator<StreamEvent> {
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
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
}
