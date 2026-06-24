// history.ts — rebuild model-facing conversation history from persisted rows.
//
// Why this exists (the "re-execution" bug):
// The chat stream route used to rebuild history as `{ role, content }` from the
// `messages.content` TEXT column alone, dropping any row whose text was empty.
// An assistant turn that produced ONLY tool calls + render directives (e.g.
// markdown.generate → a file, image.generate → an image) has an EMPTY text
// `content` — its real output lives in `content_blocks`. Those turns were
// therefore filtered out completely, so the model saw a list of USER requests
// with no evidence any were fulfilled — and dutifully re-ran every prior tool
// call on each new turn (ask for a doc, then an image, and it remakes the doc
// too; ask for a third thing and it remakes all three).
//
// Fix: never drop an assistant turn that did real work. Reconstruct a concise,
// model-facing summary of the actions it ALREADY completed (from content_blocks)
// and mark them explicitly DONE, so the model treats them as finished history,
// not pending requests.

import type { AssistantContentBlock } from "@/components/chat/stream-event-types";

/**
 * Find a human-readable artifact name produced by a tool call, by correlating
 * the tool-call's id with a `component` block (the rendered result, e.g. a
 * file-attachment whose props carry the filename/title).
 */
function artifactNameFor(
  blocks: AssistantContentBlock[],
  toolCallId: string,
): string | null {
  for (const b of blocks) {
    if (b.type === "component" && b.toolCallId === toolCallId) {
      const props = b.props as Record<string, unknown>;
      const candidate = props.name ?? props.title ?? props.filename ?? props.label;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
  }
  return null;
}

/**
 * Summarize the concrete, COMPLETED actions of one assistant turn (tool calls,
 * code executions, plans, sub-agent fan-outs) into a single model-facing line.
 * Failed/errored calls are omitted — those may legitimately be retried. Returns
 * "" when the turn completed no re-runnable actions.
 */
export function summarizeCompletedActions(blocks: AssistantContentBlock[]): string {
  const actions: string[] = [];
  // Track tool-call ids we've already described, so a produced component isn't
  // listed twice (once via its tool-call, once as a standalone artifact).
  const describedToolCallIds = new Set<string>();

  for (const b of blocks) {
    switch (b.type) {
      case "tool-call": {
        // Only a COMPLETED call is "done"; failed/pending calls may be retried.
        if (b.status !== "completed") break;
        describedToolCallIds.add(b.toolCallId);
        const artifact = artifactNameFor(blocks, b.toolCallId);
        actions.push(artifact ? `${b.capability} → ${artifact}` : b.capability);
        break;
      }
      case "code-execute": {
        if (b.status !== "completed") break;
        describedToolCallIds.add(b.toolCallId);
        actions.push(`code execution (${b.language})`);
        break;
      }
      case "plan":
        actions.push(`created the plan "${b.title}"`);
        break;
      case "subagent-fanout":
        actions.push(`dispatched ${b.children.length} sub-agent(s)`);
        break;
      default:
        break; // text/reasoning aren't standalone actions
    }
  }

  // Artifacts produced WITHOUT a sibling tool-call block (e.g. the chat
  // composer's explicit image/video buttons stream a component directly). These
  // still represent completed work, so surface them so the turn isn't dropped.
  for (const b of blocks) {
    if (b.type !== "component" || describedToolCallIds.has(b.toolCallId)) continue;
    const props = b.props as Record<string, unknown>;
    const name = props.name ?? props.title ?? props.filename ?? props.label;
    actions.push(typeof name === "string" && name.trim() ? `generated ${name.trim()}` : "generated an attachment");
  }

  if (actions.length === 0) return "";
  return `[Already completed in this turn — these requests are DONE, do not repeat them: ${actions.join("; ")}.]`;
}

/**
 * Build the model-facing text for one assistant history row: its own text plus a
 * trailing summary of the actions it completed. Returns "" only when the turn
 * had neither text nor any completed action (a genuinely empty row to drop).
 */
export function buildAssistantHistoryText(
  content: string,
  blocks: AssistantContentBlock[] | null | undefined,
): string {
  const text = content.trim();
  const summary =
    Array.isArray(blocks) && blocks.length > 0 ? summarizeCompletedActions(blocks) : "";

  if (text.length > 0 && summary.length > 0) return `${text}\n\n${summary}`;
  if (text.length > 0) return text;
  return summary;
}

export interface HistoryRow {
  role: string;
  content: string;
  contentBlocks: AssistantContentBlock[] | null | undefined;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const VALID_ROLES = new Set(["user", "assistant", "system"]);

/**
 * Convert raw DB message rows (newest-first) into chronological model messages.
 * Assistant turns carry a completed-action summary so the model never re-runs
 * finished tool calls; rows with no usable content are dropped.
 */
export function buildHistoryMessages(rowsNewestFirst: HistoryRow[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const r of rowsNewestFirst) {
    if (!VALID_ROLES.has(r.role)) continue;
    const content =
      r.role === "assistant"
        ? buildAssistantHistoryText(r.content, r.contentBlocks)
        : r.content.trim();
    if (content.length === 0) continue;
    out.push({ role: r.role as "user" | "assistant" | "system", content });
  }
  return out.reverse(); // newest-first → chronological oldest→newest
}
