import * as React from "react";
import { Suspense } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ToolCallCard } from "./tool-call-card";
import { ApprovalCard } from "./approval-card";
import { PlanCard, type AgentCapability } from "./plan-card";
import { SubagentFanout } from "./subagent-fanout";
import { MemoryCard } from "./memory-card";
import { CodeExecuteCard } from "./code-execute-card";
import { CHAT_COMPONENTS, logUnknownComponent } from "./chat-component-registry";
import type { AssistantContentBlock } from "./stream-event-types";
import { MarkdownMessage } from "./markdown-message";

export interface ChatMessage {
  publicId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  branchReason: string | null;
  siblingCount: number;
  // `content_blocks` mirrors the jsonb column on `chat.messages`. We keep
  // the plain `content` for legacy / text-only rendering and let the
  // bubble dispatch each block to the matching card when blocks exist.
  contentBlocks?: AssistantContentBlock[];
}

export interface MessageBubbleCallbacks {
  onResolveApproval?: (
    approvalId: string,
    decision: "approved" | "denied",
  ) => Promise<{ ok: boolean; error?: string }>;
  onResolvePlan?: (
    planId: string,
    decision: "approved" | "denied" | "amended",
    amendedSteps?: import("./stream-event-types").PlanStep[],
  ) => Promise<{ ok: boolean; error?: string }>;
  onNavigateToChild?: (childMessageId: string) => void;
  agentCapabilities?: readonly AgentCapability[];
}

export function MessageBubble({
  message,
  callbacks,
  children,
}: {
  message: ChatMessage;
  callbacks?: MessageBubbleCallbacks;
  children?: React.ReactNode;
}) {
  const isUser = message.role === "user";
  const blocks = message.contentBlocks;
  const hasBlocks = Array.isArray(blocks) && blocks.length > 0;

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm shadow-sm",
          isUser ? "bg-accent text-accent-foreground" : "rounded-lg border bg-card",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-xs opacity-80">
          <span className="font-semibold capitalize">{message.role}</span>
          {message.branchReason ? <Badge variant="muted">{message.branchReason}</Badge> : null}
        </div>

        {hasBlocks ? (
          <div className="space-y-2">
            {blocks!.map((block, idx) => renderBlock(block, idx, callbacks))}
          </div>
        ) : (
          <MarkdownMessage>{message.content}</MarkdownMessage>
        )}

        {children}
      </div>
    </div>
  );
}

// Dispatch switch — kept exhaustive so a missing block type is a type
// error at build time rather than silent skip at runtime.
function renderBlock(
  block: AssistantContentBlock,
  idx: number,
  callbacks?: MessageBubbleCallbacks,
): React.ReactNode {
  switch (block.type) {
    case "text":
      return (
        <MarkdownMessage key={idx}>
          {block.text}
        </MarkdownMessage>
      );
    case "tool-call":
      return (
        <ToolCallCard
          key={block.toolCallId}
          toolCallId={block.toolCallId}
          capability={block.capability}
          inputPreview={block.inputPreview}
          riskLevel={block.riskLevel}
          status={block.status}
          output={block.output}
          stdout={block.stdout}
          stderr={block.stderr}
          errorReason={block.errorReason}
          durationMs={block.durationMs}
        />
      );
    case "code-execute":
      return (
        <CodeExecuteCard
          key={block.toolCallId}
          toolCallId={block.toolCallId}
          language={block.language}
          code={block.code}
          status={block.status}
          stdout={block.stdout}
          stderr={block.stderr}
          exitCode={block.exitCode}
          oomKilled={block.oomKilled}
          durationMs={block.durationMs}
        />
      );
    case "approval-request":
      return (
        <ApprovalCard
          key={block.approvalId}
          approvalId={block.approvalId}
          capability={block.capability}
          inputPreview={block.inputPreview}
          riskLevel={block.riskLevel}
          expiresAt={block.expiresAt}
          resolution={block.resolution}
          onResolved={callbacks?.onResolveApproval}
        />
      );
    case "plan":
      return (
        <PlanCard
          key={block.planId}
          planId={block.planId}
          title={block.title}
          steps={block.steps}
          rationale={block.rationale}
          status={block.status}
          agentCapabilities={callbacks?.agentCapabilities}
          onResolve={callbacks?.onResolvePlan}
        />
      );
    case "subagent-fanout":
      return (
        <SubagentFanout
          key={block.fanoutId}
          fanoutId={block.fanoutId}
          parentMessageId={block.parentMessageId}
          subagents={block.children}
          status={block.status}
          results={block.results}
          onSelectChild={callbacks?.onNavigateToChild}
        />
      );
    case "memory-recall":
      return <MemoryCard key={block.queryId} queryId={block.queryId} memories={block.memories} />;
    case "component": {
      const Component = CHAT_COMPONENTS[block.componentId];
      if (!Component) {
        // Unknown componentId — log intent but render nothing rather than
        // crashing so a stale persisted block doesn't break the whole chat.
        logUnknownComponent(block.componentId);
        return null;
      }
      return (
        <Suspense
          key={block.toolCallId}
          fallback={
            // Tasteful skeleton: an opaque card with two shimmer lines to
            // suggest loading content.
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
          <Component {...block.props} />
        </Suspense>
      );
    }
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}
