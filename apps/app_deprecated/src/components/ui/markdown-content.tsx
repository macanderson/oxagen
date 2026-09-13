"use client";

/**
 * MarkdownContent — the single read-only markdown renderer for NON-chat
 * surfaces (memory bodies, truncation popovers, anywhere we display stored
 * markdown to the user).
 *
 * Product rule: we never show raw markdown *language* in read-only contexts —
 * markdown is always styled to HTML. This wraps the same Streamdown-based
 * <MarkdownMessage> the chat transcript uses so there is exactly one markdown
 * styling path in the app (Shiki code highlighting, Mermaid, responsive tables,
 * link safety). Editing surfaces use <MarkdownCodeEditor> instead.
 */

import * as React from "react";

import { MarkdownMessage } from "@/components/chat/markdown-message";
import { cn } from "@/lib/utils";

export interface MarkdownContentProps {
  /** Markdown source to render as styled HTML. */
  children: string;
  className?: string;
}

export function MarkdownContent({ children, className }: MarkdownContentProps) {
  return (
    <MarkdownMessage className={cn("text-sm leading-relaxed", className)}>
      {children}
    </MarkdownMessage>
  );
}
