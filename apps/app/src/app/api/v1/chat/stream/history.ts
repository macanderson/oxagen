// history.ts — rebuild model-facing conversation history from persisted rows.
//
// An assistant turn that produced ONLY tool calls + render directives (e.g.
// markdown.generate → a file, image.generate → an image) has an EMPTY text
// `messages.content` — its real output lives in `content_blocks`. Rebuilding
// history from `content` alone would drop those turns, so the model would see
// a list of USER requests with no evidence any were fulfilled, and would
// re-run every prior tool call on each new turn (ask for a doc, then an
// image, and it remakes the doc too; ask for a third thing and it remakes
// all three).
//
// So: never drop an assistant turn that did real work. Reconstruct a concise,
// model-facing summary of the actions it ALREADY completed (from content_blocks)
// and mark them explicitly DONE, so the model treats them as finished history,
// not pending requests.

import type { AssistantContentBlock } from "@/components/chat/stream-event-types";
import type { ModelMessage } from "@oxagen/ai";

// How many of the most-recent user turns get their attached images replayed
// as real multimodal parts on every subsequent request. Older turns fall back
// to a text placeholder — without this bound, a long conversation with several
// image turns would re-send every image on every turn, growing vision-token
// cost (and prompt-hash/latency) unboundedly. Mirrors the stream route's
// per-turn attachment cap philosophy (BodySchema `.max(8)`), just applied
// across turns instead of within one.
const RECENT_IMAGE_TURN_LIMIT = 2;

/** One attachment ref as persisted in a user message's `metadata.attachments`
 * (see sendMessageAction / wandSendAction). */
export interface HistoryAttachmentRef {
  publicId: string;
  kind: string;
  name: string;
}

/**
 * Extract `metadata.attachments` as validated `HistoryAttachmentRef[]`.
 * Defensive: malformed/absent metadata (including rows from before this
 * feature shipped) yields `null` rather than throwing.
 */
function attachmentsFromMetadata(
  metadata: unknown,
): HistoryAttachmentRef[] | null {
  if (!metadata || typeof metadata !== "object" || !("attachments" in metadata))
    return null;
  const raw = (metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const valid = raw.filter(
    (a): a is HistoryAttachmentRef =>
      !!a &&
      typeof a === "object" &&
      typeof (a as HistoryAttachmentRef).publicId === "string" &&
      typeof (a as HistoryAttachmentRef).kind === "string" &&
      typeof (a as HistoryAttachmentRef).name === "string",
  );
  return valid.length > 0 ? valid : null;
}

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
      const candidate =
        props.name ?? props.title ?? props.filename ?? props.label;
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
export function summarizeCompletedActions(
  blocks: AssistantContentBlock[],
): string {
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
    if (b.type !== "component" || describedToolCallIds.has(b.toolCallId))
      continue;
    const props = b.props as Record<string, unknown>;
    const name = props.name ?? props.title ?? props.filename ?? props.label;
    actions.push(
      typeof name === "string" && name.trim()
        ? `generated ${name.trim()}`
        : "generated an attachment",
    );
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
    Array.isArray(blocks) && blocks.length > 0
      ? summarizeCompletedActions(blocks)
      : "";

  if (text.length > 0 && summary.length > 0) return `${text}\n\n${summary}`;
  if (text.length > 0) return text;
  return summary;
}

export interface HistoryRow {
  role: string;
  content: string;
  contentBlocks: AssistantContentBlock[] | null | undefined;
  /** Raw `messages.metadata` jsonb — carries `attachments` for user turns. */
  metadata?: unknown;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** A fetched image ready to attach as a multimodal content part. */
export interface ResolvedHistoryImage {
  data: Buffer;
  mediaType: string;
}

const VALID_ROLES = new Set(["user", "assistant", "system"]);

/**
 * Scan rows (newest-first) and return the attachment publicIds belonging to
 * the most recent `RECENT_IMAGE_TURN_LIMIT` user turns — i.e. exactly the set
 * `buildHistoryMessages` needs real image bytes for. Pure/no I/O: the caller
 * (the stream route) fetches bytes for these ids and passes the result back
 * in as `resolvedImages`.
 */
export function collectRecentAttachmentPublicIds(
  rowsNewestFirst: HistoryRow[],
): string[] {
  const ids: string[] = [];
  let recentUserTurns = 0;
  for (const r of rowsNewestFirst) {
    if (r.role !== "user") continue;
    if (recentUserTurns >= RECENT_IMAGE_TURN_LIMIT) break;
    recentUserTurns += 1;
    const attachments = attachmentsFromMetadata(r.metadata);
    if (!attachments) continue;
    for (const a of attachments) {
      if (a.kind === "image") ids.push(a.publicId);
    }
  }
  return ids;
}

/** Build the placeholder text appended for attachments NOT replayed as real
 * image parts — either because the turn fell outside the recent window, or
 * because a particular attachment's bytes failed to resolve. */
function attachmentPlaceholderText(
  attachments: HistoryAttachmentRef[],
): string {
  return attachments.map((a) => `[attached image: ${a.name}]`).join("\n");
}

/**
 * Convert raw DB message rows (newest-first) into chronological model
 * messages. Assistant turns carry a completed-action summary so the model
 * never re-runs finished tool calls; rows with no usable content are dropped.
 *
 * User turns with `metadata.attachments`: the most recent
 * `RECENT_IMAGE_TURN_LIMIT` such turns re-attach real image parts (using
 * `resolvedImages`, keyed by attachment publicId — see
 * `collectRecentAttachmentPublicIds`); every older turn (and any attachment
 * missing from `resolvedImages`, e.g. a since-deleted asset) degrades to a
 * `[attached image: <name>]` text placeholder. This bounds vision-token
 * growth over a long conversation instead of re-sending every past image on
 * every turn.
 */
export function buildHistoryMessages(
  rowsNewestFirst: HistoryRow[],
  resolvedImages: ReadonlyMap<string, ResolvedHistoryImage> = new Map(),
): ModelMessage[] {
  const out: ModelMessage[] = [];
  let recentUserTurns = 0;

  for (const r of rowsNewestFirst) {
    if (!VALID_ROLES.has(r.role)) continue;

    if (r.role === "user") {
      const attachments = attachmentsFromMetadata(r.metadata);
      const isRecentTurn = recentUserTurns < RECENT_IMAGE_TURN_LIMIT;
      recentUserTurns += 1;

      if (attachments) {
        const imageAttachments = attachments.filter((a) => a.kind === "image");
        const resolved = isRecentTurn
          ? imageAttachments
              .map((a) => resolvedImages.get(a.publicId))
              .filter((img): img is ResolvedHistoryImage => img !== undefined)
          : [];
        const unresolved = isRecentTurn
          ? imageAttachments.filter((a) => !resolvedImages.has(a.publicId))
          : imageAttachments;

        const text = [r.content.trim(), attachmentPlaceholderText(unresolved)]
          .filter((s) => s.length > 0)
          .join("\n");

        if (resolved.length > 0) {
          const parts: Array<
            | { type: "text"; text: string }
            | { type: "image"; image: Buffer; mediaType: string }
          > = [];
          if (text.length > 0) parts.push({ type: "text", text });
          for (const img of resolved) {
            parts.push({
              type: "image",
              image: img.data,
              mediaType: img.mediaType,
            });
          }
          out.push({ role: "user", content: parts });
          continue;
        }
        if (text.length > 0) out.push({ role: "user", content: text });
        continue;
      }

      const content = r.content.trim();
      if (content.length > 0) out.push({ role: "user", content });
      continue;
    }

    const content =
      r.role === "assistant"
        ? buildAssistantHistoryText(r.content, r.contentBlocks)
        : r.content.trim();
    if (content.length === 0) continue;
    out.push({ role: r.role as "assistant" | "system", content });
  }
  return out.reverse(); // newest-first → chronological oldest→newest
}
