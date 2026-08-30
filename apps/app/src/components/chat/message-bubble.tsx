import * as React from "react";
import { Suspense } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ToolCallCard } from "./tool-call-card";
import {
  ToolActivityGroup,
  type ToolActivityItem,
} from "./tool-activity-group";
import { ApprovalCard } from "./approval-card";
import { ConsentCard } from "./consent-card";
import { PlanCard, type AgentCapability } from "./plan-card";
import { SubagentFanout } from "./subagent-fanout";
import { MemoryCard } from "./memory-card";
import { BackgroundTaskCard } from "./background-task-card";
import { CodeExecuteCard } from "./code-execute-card";
import { ReasoningCard } from "./reasoning-card";
import {
  ActivityTimeline,
  TimelineItem,
  type TimelineItemProps,
} from "./activity-timeline";
import {
  CHAT_COMPONENTS,
  logUnknownComponent,
  UnknownComponentCard,
} from "./chat-component-registry";
import type {
  AssistantContentBlock,
  MessageReceipt,
  ToolCallContentBlock,
} from "./stream-event-types";
import { MessageReceiptLine } from "./message-receipt";
import { MarkdownMessage } from "./markdown-message";
import { MessageFooter } from "./message-footer";
import ImagePreview from "./registry-components/image-preview";
import FileAttachment from "./registry-components/file-attachment";

/**
 * A user-turn attachment ref persisted in `messages.metadata.attachments`
 * (see the chat stream route). Mirrors `conversationAssetItem`'s display
 * fields — the `url` is always the access-controlled `/api/v1/assets/:publicId`
 * serving path, never a raw blob URL.
 */
export interface MessageAttachment {
  publicId: string;
  kind: string;
  name: string;
  mimeType: string;
  url: string;
}

export interface ChatMessage {
  publicId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  branchReason: string | null;
  siblingCount: number;
  // `content_blocks` mirrors the jsonb column on `chat.messages`. Plain
  // `content` renders when there are no blocks; each block otherwise
  // dispatches to its matching card.
  contentBlocks?: AssistantContentBlock[];
  /** User-turn attachments (Phase 1: images), from `messages.metadata.attachments`. */
  attachments?: MessageAttachment[];
  /** Run receipt (chat_ux_v2), from `messages.metadata.receipt`. */
  receipt?: MessageReceipt | null;
}

export interface MessageBubbleCallbacks {
  onResolveApproval?: (
    approvalId: string,
    decision: "approved" | "denied",
  ) => Promise<{ ok: boolean; error?: string }>;
  onResolveConsent?: (
    approvalId: string,
    decision: "granted" | "denied",
    grantAllTools: boolean,
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
  orgSlug,
  workspaceSlug,
}: {
  message: ChatMessage;
  callbacks?: MessageBubbleCallbacks;
  children?: React.ReactNode;
  /** Slug context for footer server actions (required for assistant messages). */
  orgSlug?: string;
  workspaceSlug?: string;
}) {
  const isUser = message.role === "user";
  const blocks = message.contentBlocks;
  const hasBlocks = Array.isArray(blocks) && blocks.length > 0;
  // Render as a connected timeline (matching the live turn) only when the
  // message actually has a chain — reasoning, a tool call, or several blocks.
  // A lone text block renders plainly, without a rail.
  const useTimeline =
    hasBlocks && (blocks.length > 1 || blocks.some((b) => b.type !== "text"));

  // Collect plain text for the footer's copy / save actions. Content-block text
  // takes precedence (it is the extracted prose); fall back to message.content.
  const assistantText = React.useMemo(() => {
    if (!hasBlocks) return message.content;
    return blocks!
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
  }, [hasBlocks, blocks, message.content]);

  const showFooter =
    !isUser && orgSlug !== undefined && workspaceSlug !== undefined;

  return (
    <div
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[80%] px-4 py-3 text-sm shadow-sm",
          isUser
            ? "bg-accent text-accent-foreground"
            : "rounded-xl border bg-card",
        )}
        style={isUser ? { borderRadius: "16px 16px 4px 16px" } : undefined}
      >
        <div className="mb-1 flex items-center gap-2 text-xs opacity-80">
          <span className="font-semibold capitalize">{message.role}</span>
          {message.branchReason ? (
            <Badge variant="muted">{message.branchReason}</Badge>
          ) : null}
        </div>

        {message.attachments && message.attachments.length > 0 ? (
          <div
            className="mb-2 flex flex-wrap gap-2"
            data-testid="message-attachments"
          >
            {message.attachments.map((a) =>
              a.kind === "image" ? (
                <div key={a.publicId} className="w-full max-w-[240px]">
                  <ImagePreview url={a.url} alt={a.name} />
                </div>
              ) : (
                <FileAttachment
                  key={a.publicId}
                  url={a.url}
                  name={a.name}
                  kind={a.kind}
                  mimeType={a.mimeType}
                />
              ),
            )}
          </div>
        ) : null}

        {hasBlocks ? (
          useTimeline ? (
            <ActivityTimeline>
              {groupBlocks(blocks!).map((unit) =>
                unit.kind === "tool-group" ? (
                  <TimelineItem
                    key={`tool-group:${unit.blocks[0]!.toolCallId}`}
                    tone={toolGroupTone(unit.blocks)}
                  >
                    <ToolActivityGroup
                      items={unit.blocks.map(toolCallBlockToItem)}
                      live={false}
                    />
                  </TimelineItem>
                ) : (
                  <TimelineItem
                    key={blockKey(unit.block, unit.idx)}
                    tone={blockTone(unit.block)}
                  >
                    {renderBlock(unit.block, unit.idx, callbacks)}
                  </TimelineItem>
                ),
              )}
            </ActivityTimeline>
          ) : (
            <div className="space-y-2">
              {groupBlocks(blocks!).map((unit) =>
                unit.kind === "tool-group" ? (
                  <ToolActivityGroup
                    key={`tool-group:${unit.blocks[0]!.toolCallId}`}
                    items={unit.blocks.map(toolCallBlockToItem)}
                    live={false}
                  />
                ) : (
                  <React.Fragment key={blockKey(unit.block, unit.idx)}>
                    {renderBlock(unit.block, unit.idx, callbacks)}
                  </React.Fragment>
                ),
              )}
            </div>
          )
        ) : (
          <MarkdownMessage>{message.content}</MarkdownMessage>
        )}

        {message.role === "assistant" && message.receipt ? (
          <MessageReceiptLine receipt={message.receipt} />
        ) : null}

        {showFooter ? (
          <MessageFooter
            text={assistantText}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        ) : null}

        {children}
      </div>
    </div>
  );
}

// A renderable unit: either a single block, or a run of consecutive tool-call
// blocks merged into one compact activity group. Merging keeps the frequent,
// low-signal tool calls from dominating the persisted conversation history.
type BlockUnit =
  | { kind: "single"; block: AssistantContentBlock; idx: number }
  | { kind: "tool-group"; blocks: ToolCallContentBlock[]; startIdx: number };

function groupBlocks(blocks: AssistantContentBlock[]): BlockUnit[] {
  const units: BlockUnit[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.type === "tool-call") {
      const run: ToolCallContentBlock[] = [];
      const startIdx = i;
      while (i < blocks.length && blocks[i]!.type === "tool-call") {
        run.push(blocks[i] as ToolCallContentBlock);
        i++;
      }
      units.push({ kind: "tool-group", blocks: run, startIdx });
    } else {
      units.push({ kind: "single", block, idx: i });
      i++;
    }
  }
  return units;
}

function toolCallBlockToItem(block: ToolCallContentBlock): ToolActivityItem {
  return {
    toolCallId: block.toolCallId,
    capability: block.capability,
    inputPreview: block.inputPreview,
    riskLevel: block.riskLevel,
    status: block.status,
    output: block.output,
    stdout: block.stdout,
    stderr: block.stderr,
    errorReason: block.errorReason,
    durationMs: block.durationMs,
  };
}

// The rail dot for a tool group stays calm: running while anything is in-flight,
// otherwise done — never "failed", so a single failed call doesn't paint the
// whole thread with an alarm color.
function toolGroupTone(
  blocks: ToolCallContentBlock[],
): NonNullable<TimelineItemProps["tone"]> {
  return blocks.some((b) => b.status === "pending" || b.status === "running")
    ? "running"
    : "done";
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
      return <MarkdownMessage key={idx}>{block.text}</MarkdownMessage>;
    case "reasoning":
      // Persisted reasoning is terminal: render collapsed ("Thought for Xs"),
      // re-expandable. status="done" so it never shows the live typewriter.
      return (
        <ReasoningCard
          key={`reasoning:${block.reasoningId}`}
          text={block.text}
          status="done"
          durationMs={block.durationMs}
        />
      );
    case "tool-call":
      return (
        <ToolCallCard
          key={`tool-call:${block.toolCallId}`}
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
          key={`code-execute:${block.toolCallId}`}
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
          key={`approval:${block.approvalId}`}
          approvalId={block.approvalId}
          capability={block.capability}
          inputPreview={block.inputPreview}
          riskLevel={block.riskLevel}
          expiresAt={block.expiresAt}
          resolution={block.resolution}
          onResolved={callbacks?.onResolveApproval}
        />
      );
    case "consent-request":
      return (
        <ConsentCard
          key={`consent:${block.approvalId}`}
          approvalId={block.approvalId}
          capability={block.capability}
          serverId={block.serverId}
          toolName={block.toolName}
          inputPreview={block.inputPreview}
          expiresAt={block.expiresAt}
          resolution={block.resolution}
          onResolved={callbacks?.onResolveConsent}
        />
      );
    case "plan":
      return (
        <PlanCard
          key={`plan:${block.planId}`}
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
          key={`fanout:${block.fanoutId}`}
          fanoutId={block.fanoutId}
          parentMessageId={block.parentMessageId}
          subagents={block.children}
          status={block.status}
          results={block.results}
          onSelectChild={callbacks?.onNavigateToChild}
        />
      );
    case "memory-recall":
      return (
        <MemoryCard
          key={`memory:${block.queryId}`}
          queryId={block.queryId}
          memories={block.memories}
        />
      );
    case "background-task":
      return (
        <BackgroundTaskCard
          key={`bgtask:${block.taskId}`}
          taskId={block.taskId}
          kind={block.kind}
          label={block.label}
          status={block.status}
          inngestRunId={block.inngestRunId}
        />
      );
    case "component": {
      const Component = CHAT_COMPONENTS[block.componentId];
      if (!Component) {
        // Unknown componentId — log for observability and render a visible
        // fallback so the user gets a clear signal instead of a silent gap.
        logUnknownComponent(block.componentId);
        return (
          <UnknownComponentCard
            key={`component:${block.toolCallId}`}
            componentId={block.componentId}
          />
        );
      }
      return (
        <Suspense
          key={`component:${block.toolCallId}`}
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

// Tone of a persisted block's timeline rail dot. Persisted blocks are terminal,
// so this maps the stored status to the final-state color.
function blockTone(
  block: AssistantContentBlock,
): NonNullable<TimelineItemProps["tone"]> {
  switch (block.type) {
    case "text":
      return "idle";
    case "reasoning":
    case "memory-recall":
    case "component":
      return "done";
    case "tool-call":
    case "code-execute":
      return block.status === "completed"
        ? "done"
        : block.status === "failed"
          ? "failed"
          : "running";
    case "approval-request":
    case "consent-request":
      return block.resolution ? "done" : "running";
    case "plan":
      return block.status === "pending" ? "running" : "done";
    case "subagent-fanout":
      return block.status === "completed"
        ? "done"
        : block.status === "running"
          ? "running"
          : "failed";
    case "background-task":
      return block.status === "running"
        ? "running"
        : block.status === "failed"
          ? "failed"
          : "done";
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

// Stable React key for a persisted block — type-prefixed so a tool-call block
// and its companion component block (sharing the same toolCallId) never collide.
function blockKey(block: AssistantContentBlock, idx: number): string {
  switch (block.type) {
    case "reasoning":
      return `reasoning:${block.reasoningId}`;
    case "tool-call":
      return `tool-call:${block.toolCallId}`;
    case "code-execute":
      return `code-execute:${block.toolCallId}`;
    case "component":
      return `component:${block.toolCallId}`;
    case "approval-request":
      return `approval:${block.approvalId}`;
    case "consent-request":
      return `consent:${block.approvalId}`;
    case "plan":
      return `plan:${block.planId}`;
    case "subagent-fanout":
      return `fanout:${block.fanoutId}`;
    case "memory-recall":
      return `memory:${block.queryId}`;
    case "background-task":
      return `bgtask:${block.taskId}`;
    case "text":
      return `text-${idx}`;
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}
