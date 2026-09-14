"use client";

/**
 * MarkdownCodeEditor — a VSCode-style plain-text editor for authoring markdown.
 *
 * This is the single input surface for any markdown the user TYPES or EDITS in
 * the app (memory bodies, workspace prompt configs). Per the product rule we
 * never render markdown *source* as styled prose while editing — the user sees
 * the raw markdown with syntax highlighting and gutter line numbers, exactly
 * like a code editor. Read-only display of that same content goes through
 * <MarkdownContent> (Streamdown → styled HTML) instead.
 *
 * Built on CodeMirror 6 via @uiw/react-codemirror:
 *   - `basicSetup` provides the line-number gutter, active-line highlight, and
 *     bracket matching out of the box.
 *   - `@codemirror/lang-markdown` gives markdown syntax highlighting, with
 *     `codeLanguages` wired to the full language-data set so fenced code blocks
 *     highlight their embedded language too.
 *   - `oneDark` gives the familiar dark "editor" chrome regardless of app theme,
 *     so the surface always reads as a deliberate code editor.
 */

import * as React from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";

import { cn } from "@/lib/utils";

export interface MarkdownCodeEditorProps {
  /** Current markdown source. Controlled. */
  value: string;
  /** Called with the new markdown source on every edit. */
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  /** Hard character cap — edits that would exceed it are rejected. */
  maxLength?: number;
  disabled?: boolean;
  /** Minimum editor height, e.g. "8rem". Defaults to "8rem". */
  minHeight?: string;
  /** Maximum editor height before the editor scrolls, e.g. "24rem". */
  maxHeight?: string;
  ariaLabel?: string;
  className?: string;
}

export function MarkdownCodeEditor({
  value,
  onChange,
  id,
  placeholder,
  maxLength,
  disabled = false,
  minHeight = "8rem",
  maxHeight,
  ariaLabel,
  className,
}: MarkdownCodeEditorProps) {
  const ref = React.useRef<ReactCodeMirrorRef>(null);

  const extensions = React.useMemo(() => {
    const base = [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
    ];
    if (placeholder) {
      base.push(cmPlaceholder(placeholder));
    }
    if (typeof maxLength === "number") {
      // Reject any transaction that would push the doc past the cap. This keeps
      // the hard limit enforced at the source instead of truncating after the
      // fact (which would fight the user's cursor).
      base.push(
        EditorState.changeFilter.of((tr) => tr.newDoc.length <= maxLength),
      );
    }
    return base;
  }, [placeholder, maxLength]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border/60 focus-within:ring-1 focus-within:ring-ring",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <CodeMirror
        ref={ref}
        id={id}
        value={value}
        onChange={onChange}
        theme={oneDark}
        extensions={extensions}
        editable={!disabled}
        readOnly={disabled}
        minHeight={minHeight}
        maxHeight={maxHeight}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          foldGutter: false,
          bracketMatching: true,
          autocompletion: false,
        }}
        aria-label={ariaLabel}
        className="text-sm"
      />
    </div>
  );
}
