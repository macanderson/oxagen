// The in-app assistant's context window, block by block (ADR-193).
//
// `runGovernedTurn` builds the opening transcript from four parts it knows
// apart: the system prompt, the history, the context the host placed after
// it (recalled memory, page context) and the person's message. The engine
// then asks the host for each completion with the transcript so far, and
// the host measures that request before it contacts the provider. The
// measurement rides the `model.engine_call_started` frame as its `window`.
//
// Each block is the UTF-8 length of its parts' JSON. No token is counted
// here: the reader divides the prompt total the provider reported on the
// completion across the blocks by their bytes, so the blocks sum to it and
// nothing is tokenized locally.
import type { ContextWindowPayload } from "@oxagen/run-ledger";

type ContextWindowBlock = ContextWindowPayload["blocks"][number];

/** The UTF-8 length of `value` as JSON, the measure `@oxagen/tacho` uses. */
function windowJsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  } catch {
    return 0;
  }
}

/**
 * What the host knows about the window's parts that the request alone does
 * not say: the steering text the system prompt ends with, and the messages it
 * placed as context rather than conversation.
 */
export interface ContextWindowLayout {
  /** The steering text inside the system prompt, exactly as appended; null when none. */
  steering: string | null;
  /**
   * Each context message the host placed in the window, by role and text: a
   * history summary, page context, recalled memory. A request message that
   * matches one is `context`; any other message is `conversation`.
   */
  context: readonly { role: string; content: string }[];
}

type RequestMessage = { role?: unknown; content?: unknown };

function messagesOf(request: unknown): RequestMessage[] {
  if (typeof request !== "object" || request === null) return [];
  const messages = (request as { messages?: unknown }).messages;
  return Array.isArray(messages)
    ? messages.filter(
        (message): message is RequestMessage =>
          typeof message === "object" && message !== null,
      )
    : [];
}

function toolsOf(request: unknown): unknown[] {
  if (typeof request !== "object" || request === null) return [];
  const tools = (request as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : [];
}

const contextKey = (role: unknown, content: unknown): string | null =>
  typeof role === "string" && typeof content === "string"
    ? `${role}\u0000${content}`
    : null;

/**
 * The window of one completion request, or null when it carried nothing to
 * measure.
 *
 * The system message is the first message when its role is `system`. When
 * its text carries the layout's steering, the steering's escaped length is
 * split out of it: JSON escapes each character on its own, so the escaped
 * steering is exactly its share of the system message's JSON. A context
 * message is matched once per placement, so a person who types the same
 * words as a recalled memory is still conversation.
 */
export function measureCompletionRequest(
  request: unknown,
  layout: ContextWindowLayout,
): ContextWindowPayload | null {
  const messages = messagesOf(request);
  const tools = toolsOf(request);
  const placed = new Map<string, number>();
  for (const message of layout.context) {
    const key = contextKey(message.role, message.content);
    if (key !== null) placed.set(key, (placed.get(key) ?? 0) + 1);
  }

  const block = (kind: ContextWindowBlock["kind"]): ContextWindowBlock => ({
    kind,
    bytes: 0,
    items: 0,
  });
  const system = block("system");
  const steering = block("steering");
  const context = block("context");
  const conversation = block("conversation");
  messages.forEach((message, index) => {
    const bytes = windowJsonBytes(message);
    if (index === 0 && message.role === "system") {
      const text = typeof message.content === "string" ? message.content : "";
      const carried =
        layout.steering !== null &&
        layout.steering.length > 0 &&
        text.includes(layout.steering)
          ? Math.max(0, windowJsonBytes(layout.steering) - 2)
          : 0;
      system.bytes = bytes - carried;
      system.items = 1;
      if (carried > 0) {
        steering.bytes = carried;
        steering.items = 1;
      }
      return;
    }
    const key = contextKey(message.role, message.content);
    const left = key === null ? 0 : (placed.get(key) ?? 0);
    const into = left > 0 ? context : conversation;
    if (left > 0 && key !== null) placed.set(key, left - 1);
    into.bytes += bytes;
    into.items += 1;
  });
  const toolBlock: ContextWindowBlock = {
    kind: "tools",
    bytes: tools.reduce<number>((sum, tool) => sum + windowJsonBytes(tool), 0),
    items: tools.length,
  };
  const blocks = [system, steering, toolBlock, context, conversation];
  return blocks.every((b) => b.bytes === 0) ? null : { blocks };
}
