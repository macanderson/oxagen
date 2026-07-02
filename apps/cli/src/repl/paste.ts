/**
 * Paste placeholder registry for {@link PromptInput}.
 *
 * A large text paste or an image paste collapses to a compact token —
 * `[CopiedText-N]` / `[Image#N]` — inserted at the cursor so the bar shows a
 * short reference instead of a wall of pasted content (mirrors Claude Code).
 * The registry maps each token's N back to the real content; it is owned by
 * `PromptInput` (same lifecycle as its buffer) and reset every submit, so
 * numbering restarts at 1 for the next prompt.
 *
 * Pure and React-free so every rule here (threshold, token grammar, atomic
 * deletion, expansion) is unit-testable without ink.
 */
import type { PastedImageAttachment } from "../lib/clipboard-image.js";

export type { PastedImageAttachment };

export interface PasteRegistry {
  texts: Map<number, string>;
  images: Map<number, PastedImageAttachment>;
  nextTextId: number;
  nextImageId: number;
}

export function createPasteRegistry(): PasteRegistry {
  return { texts: new Map(), images: new Map(), nextTextId: 1, nextImageId: 1 };
}

/** Clear all entries and restart both counters at 1 — called on every submit/clear. */
export function resetPasteRegistry(registry: PasteRegistry): void {
  registry.texts.clear();
  registry.images.clear();
  registry.nextTextId = 1;
  registry.nextImageId = 1;
}

/** A paste collapses to `[CopiedText-N]` once it exceeds either bound. */
export const PASTE_TEXT_CHAR_THRESHOLD = 400;
export const PASTE_TEXT_LINE_THRESHOLD = 6;

/** Large-paste heuristic: >400 chars OR >=6 lines. Small pastes insert inline, unchanged. */
export function shouldCollapseText(text: string): boolean {
  return (
    text.length > PASTE_TEXT_CHAR_THRESHOLD || text.split("\n").length >= PASTE_TEXT_LINE_THRESHOLD
  );
}

export function copiedTextToken(n: number): string {
  return `[CopiedText-${n}]`;
}

export function imageToken(n: number): string {
  return `[Image#${n}]`;
}

/** Register a large pasted text blob; returns the compact token to insert at the cursor. */
export function registerPastedText(registry: PasteRegistry, fullText: string): string {
  const n = registry.nextTextId++;
  registry.texts.set(n, fullText);
  return copiedTextToken(n);
}

/** Register a pasted image; returns the compact token to insert at the cursor. */
export function registerPastedImage(registry: PasteRegistry, attachment: PastedImageAttachment): string {
  const n = registry.nextImageId++;
  registry.images.set(n, attachment);
  return imageToken(n);
}

const TOKEN_RE = /\[(?:CopiedText-(\d+)|Image#(\d+))\]/g;
const TOKEN_AT_END_RE = /\[(?:CopiedText-\d+|Image#\d+)\]$/;
const TOKEN_AT_START_RE = /^\[(?:CopiedText-\d+|Image#\d+)\]/;

/** The span `[start, end)` of a full token immediately BEFORE `pos`, or null if there isn't one. */
export function tokenEndingAt(text: string, pos: number): { start: number; end: number } | null {
  const m = TOKEN_AT_END_RE.exec(text.slice(0, pos));
  return m ? { start: pos - m[0].length, end: pos } : null;
}

/** The span `[start, end)` of a full token immediately AFTER `pos`, or null if there isn't one. */
export function tokenStartingAt(text: string, pos: number): { start: number; end: number } | null {
  const m = TOKEN_AT_START_RE.exec(text.slice(pos));
  return m ? { start: pos, end: pos + m[0].length } : null;
}

/** Drop the registry entry for the token exactly spanning `text.slice(span.start, span.end)`, if any. */
export function dropTokenAt(
  registry: PasteRegistry,
  text: string,
  span: { start: number; end: number },
): void {
  const token = text.slice(span.start, span.end);
  const textMatch = /^\[CopiedText-(\d+)\]$/.exec(token);
  if (textMatch) {
    registry.texts.delete(Number(textMatch[1]));
    return;
  }
  const imgMatch = /^\[Image#(\d+)\]$/.exec(token);
  if (imgMatch) registry.images.delete(Number(imgMatch[1]));
}

/**
 * Drop every registry entry whose token no longer appears anywhere in `text` —
 * the minimum deletion contract: however a token got mangled (atomic
 * backspace, cursor-into-the-middle character erosion, retyping), a token
 * that isn't intact in the buffer at submit time can't resurrect stale
 * content or leak a dangling temp-file reference.
 */
export function pruneMissingTokens(registry: PasteRegistry, text: string): void {
  for (const n of registry.texts.keys()) {
    if (!text.includes(copiedTextToken(n))) registry.texts.delete(n);
  }
  for (const n of registry.images.keys()) {
    if (!text.includes(imageToken(n))) registry.images.delete(n);
  }
}

export interface PasteSubmission {
  /** `text` with every `[CopiedText-N]` token expanded inline to its full stored content, and every
   *  `[Image#N]` token replaced by a short literal note (the real bytes travel via `images`). */
  expandedText: string;
  /** Image attachments referenced by `[Image#N]` tokens still present in `text`, in submission order. */
  images: PastedImageAttachment[];
}

/**
 * Expand a submitted buffer's placeholder tokens for the model: text tokens
 * inline, image tokens become an ordered attachment list. Tokens with no
 * registry entry (typed by hand, or already pruned) are left as literal text
 * — never silently dropped. Prunes stale entries first so the registry's
 * state matches exactly what this submission references.
 */
export function expandPasteSubmission(registry: PasteRegistry, text: string): PasteSubmission {
  pruneMissingTokens(registry, text);
  const images: PastedImageAttachment[] = [];
  const expandedText = text.replace(TOKEN_RE, (match, textId: string | undefined, imgId: string | undefined) => {
    if (textId !== undefined) {
      return registry.texts.get(Number(textId)) ?? match;
    }
    const img = registry.images.get(Number(imgId));
    if (!img) return match;
    images.push(img);
    return "(attached image)";
  });
  return { expandedText, images };
}
