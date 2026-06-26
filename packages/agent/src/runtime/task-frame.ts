/**
 * TaskFrame builder — constructs the input for compile() from the
 * agent's CapabilityContext and current message history.
 */
import type { TaskFrame } from "@oxagen/engram";
import type { CapabilityContext } from "../types";

/**
 * Build a TaskFrame from the current agent context and messages.
 */
export function buildTaskFrame(
  ctx: CapabilityContext,
  messages: Array<{ role: string; content: string }>,
): TaskFrame {
  return {
    namespace: { org: ctx.orgId, workspace: ctx.workspaceId },
    taskDescription: extractTaskDescription(messages),
    workingSet: extractWorkingSet(ctx),
    recentEventIds: [],
    modelId: "default",
    sessionId: ctx.messageId ?? undefined,
    agentId: undefined,
  };
}

/**
 * Extract the current task description from the most recent user message.
 */
function extractTaskDescription(
  messages: Array<{ role: string; content: string }>,
): string {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      return messages[i]!.content.slice(0, 2000);
    }
  }
  return "";
}

/**
 * Extract the working set from the capability context.
 * The working set includes recently-touched entities (files, symbols, etc.)
 */
function extractWorkingSet(_ctx: CapabilityContext): string[] {
  // For now, return an empty working set. In Phase C (Cortex harness),
  // the daemon will maintain the active working set from file-watch events.
  // The compile() function still works without a working set — it just
  // skips graph retrieval and relies on temporal + vector + lexical.
  return [];
}
