/**
 * page-context.ts
 *
 * Builds the per-turn USER message that tells the model which page the user is
 * viewing (route + optional entity summary) and, when a fillable form is
 * registered on the page, the form's fields, their LIVE current values, and the
 * form-fill behavior rules.
 *
 * WHY a user message and NOT the system prompt — this is the whole point of the
 * module:
 *
 * Page context is VOLATILE per-turn data. The `route` changes on every
 * navigation and a form field's `current` value changes as the user types. The
 * chat system prompt, by contrast, is byte-stable across a conversation and
 * carries the Anthropic `ephemeral` prompt-cache breakpoint
 * (packages/ai/src/stream.ts). Folding volatile page context into `system`
 * mutated the cached prefix on every navigation, busting the cache breakpoint
 * mid-conversation and re-billing the FULL system prefix at full input price
 * (ADR-021 §2 — the stable prefix must stay stable). Riding page context as a
 * per-turn user message — exactly like the code-mode and pinned-context
 * messages the route already emits — keeps the cached prefix stable while
 * delivering the identical information to the model.
 *
 * The schema for `pageContext` lives inline in route.ts (which is excluded from
 * coverage); this module keeps the message-building logic testable in
 * isolation, mirroring credit-gate.ts.
 */

import type { ModelMessage } from "@oxagen/ai";

/** One fillable-form field descriptor as parsed from the request pageContext. */
export interface PageContextField {
  name: string;
  label: string;
  type: string;
  /** The field's CURRENT live value (volatile — changes as the user types). */
  current?: unknown;
  options?: { label: string; value: string }[];
  required?: boolean;
}

/** The parsed `pageContext` payload the composer sends with each turn. */
export interface PageContextInput {
  route: string;
  entitySummary?: string;
  fillableForm?: {
    formId: string;
    title: string;
    fields: PageContextField[];
  };
}

/**
 * Render the page-context payload into a per-turn user message, or `undefined`
 * when the turn carries no page context. The returned content is substantively
 * identical to the text that previously rode in the system prompt — only its
 * position (user message vs cached system prefix) changes.
 */
export function buildPageContextMessage(
  pageContext: PageContextInput | null | undefined,
): ModelMessage | undefined {
  if (!pageContext) return undefined;

  const { route, entitySummary } = pageContext;

  // Always surface the current page location to the model.
  const lines: string[] = [
    "## Current page",
    "",
    `Route: ${route}`,
    ...(entitySummary ? [`Entity: ${entitySummary}`] : []),
  ];

  if (pageContext.fillableForm) {
    const { formId, title, fields } = pageContext.fillableForm;

    // Compact field list, including each field's live current value.
    const fieldLines = fields.map((f) => {
      const optPart =
        f.options && f.options.length > 0
          ? ` options=[${f.options.map((o) => `"${o.label}"`).join(", ")}]`
          : "";
      const reqPart = f.required ? " required" : "";
      const curPart =
        f.current !== null && f.current !== undefined && f.current !== ""
          ? ` current="${String(f.current)}"`
          : "";
      return `  - ${f.name} (${f.label}) type=${f.type}${reqPart}${curPart}${optPart}`;
    });

    lines.push(
      "",
      "### Fillable form",
      "",
      `Form: "${title}" (id: ${formId})`,
      "Fields:",
      ...fieldLines,
      "",
      "**Behavior rules for form fill:**",
      "- When the user asks to fill, update, or change this form, call the `page_form_fill` tool with a clear natural-language instruction.",
      "- If the request is ambiguous (you cannot determine which field or what value without guessing), **ask a clarifying question** instead of calling the tool — never call `page_form_fill` with invented values.",
      "- After the tool returns, briefly summarize the proposed changes and tell the user to review the suggestion panel. The proposals do NOT apply until the user accepts them.",
    );
  }

  return { role: "user", content: lines.join("\n") };
}
