/**
 * copy-as-markdown.ts — Converts a conversation's messages to a well-formatted
 * Markdown string suitable for clipboard export.
 *
 * Handles content blocks (text, tool-call, reasoning) when present, and falls
 * back to plain message.content for legacy messages.
 */

import type { ChatMessage } from "@/components/chat/message-bubble";

/**
 * Convert a chat message array to a Markdown document.
 *
 * Format:
 * ```md
 * ## You
 * <user message>
 *
 * ---
 *
 * ## Assistant
 * <assistant response>
 *
 * > 🔧 Tool call: tool_name
 * > <tool call summary>
 *
 * > 💭 Reasoning
 * > <reasoning text>
 * ```
 */
export function conversationToMarkdown(messages: ChatMessage[]): string {
  if (!messages || messages.length === 0) return "";

  const sections: string[] = [];

  for (const msg of messages) {
    const roleLabel = msg.role === "user" ? "You" : capitalize(msg.role);
    const parts: string[] = [`## ${roleLabel}`];

    const blocks = msg.contentBlocks;
    const hasBlocks = Array.isArray(blocks) && blocks.length > 0;

    if (hasBlocks) {
      for (const block of blocks!) {
        switch (block.type) {
          case "text":
            parts.push((block as { type: "text"; text: string }).text);
            break;
          case "reasoning":
            parts.push(
              blockquote(
                `💭 Reasoning\n\n${(block as { type: "reasoning"; text: string }).text}`,
              ),
            );
            break;
          case "tool-call":
            parts.push(
              blockquote(
                `🔧 Tool: ${(block as unknown as { type: "tool-call"; capability: string }).capability}`,
              ),
            );
            break;
          case "code-execute":
            parts.push(
              blockquote(
                `💻 Code: ${(block as unknown as { type: "code-execute"; language: string; code: string }).language}\n\n\`\`\`${(block as unknown as { type: "code-execute"; language: string; code: string }).language}\n${(block as unknown as { type: "code-execute"; language: string; code: string }).code}\n\`\`\``,
              ),
            );
            break;
          default:
            // Unknown or non-text block types — skip silently.
            break;
        }
      }
    } else {
      parts.push(msg.content);
    }

    sections.push(parts.join("\n\n"));
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Copy the conversation to the clipboard as Markdown.
 * Returns true on success.
 */
export async function copyConversationAsMarkdown(
  messages: ChatMessage[],
): Promise<boolean> {
  const md = conversationToMarkdown(messages);
  if (!md) return false;
  try {
    await navigator.clipboard.writeText(md);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
