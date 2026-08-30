/**
 * Paste placeholder registry for {@link PromptInput}.
 *
 * A MULTI-LINE text paste or an image paste collapses to a compact chip so the
 * bar shows a short reference instead of a wall of pasted content. A text chip
 * previews what was pasted — `[<first 12 chars>...N Lines...<last 12 chars>]`
 * (e.g. `[import { Bo...113 Lines...eturn null; }]`) — so the user recognizes
 * the block at a glance; an image is `[Image #N]`. A SINGLE-LINE paste is
 * always inserted in full, unchanged, no matter how long it is.
 *
 * The registry maps each chip back to the real content; it is owned by
 * `PromptInput` (same lifecycle as its buffer) and reset every submit. Text
 * chips are keyed by their exact preview string rather than a `#N` id, so the
 * buffer the user sees IS the buffer the editor manipulates — no display
 * substitution, so cursor math, selection, and atomic deletion all operate on
 * the literal chip with zero desync.
 *
 * Pure and React-free so every rule here (collapse threshold, chip grammar,
 * atomic deletion, expansion) is unit-testable without ink.
 */
import type { PastedImageAttachment } from "../lib/clipboard-image.js";

export type { PastedImageAttachment };

export interface PasteRegistry {
  /** Preview-chip string -> the full pasted text it stands in for. */
  texts: Map<string, string>;
  /** `[Image #N]` id -> attachment. */
  images: Map<number, PastedImageAttachment>;
  nextImageId: number;
}

export function createPasteRegistry(): PasteRegistry {
  return { texts: new Map(), images: new Map(), nextImageId: 1 };
}

/** Clear all entries and restart the image counter at 1 — called on every submit/clear. */
export function resetPasteRegistry(registry: PasteRegistry): void {
  registry.texts.clear();
  registry.images.clear();
  registry.nextImageId = 1;
}

/**
 * A text paste collapses to a preview chip ONLY when it spans more than one
 * line. A single-line paste — however long — inserts in full, so short
 * snippets never turn into an opaque `[…]` the user has to expand mentally.
 */
export function shouldCollapseText(text: string): boolean {
  return countLines(text) > 1;
}

/** Line count of `text` (a chip's "N Lines" figure) — 1 for single-line input. */
export function countLines(text: string): number {
  return text.split("\n").length;
}

/** How many characters of head/tail a chip previews. */
export const CHIP_EDGE = 12;

/**
 * Flatten arbitrary pasted text into a single clean line safe to embed in a
 * chip: newlines/tabs/control chars become spaces, runs of whitespace collapse
 * to one, and square brackets become `·` so a chip can neither break its own
 * `[ ]` delimiters nor accidentally spell another token's grammar (`[Image
 * #N]`) inside itself.
 */
function flattenForChip(text: string): string {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/[[\]]/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The preview chip for a multi-line paste:
 * `[<first 12>...N Lines...<last 12>]`. For a paste short enough that head and
 * tail would overlap, the tail simply continues where the head stops, so no
 * character is duplicated or dropped.
 */
export function textChip(fullText: string): string {
  const lines = countLines(fullText);
  const flat = flattenForChip(fullText);
  const head = flat.slice(0, CHIP_EDGE);
  const tail =
    flat.length <= CHIP_EDGE * 2
      ? flat.slice(head.length)
      : flat.slice(-CHIP_EDGE);
  return `[${head}...${lines} Lines...${tail}]`;
}

export function imageToken(n: number): string {
  return `[Image #${n}]`;
}

/** Append a `(k)` discriminator just inside a chip's closing bracket. */
function withCounter(chip: string, k: number): string {
  return `${chip.slice(0, -1)} (${k})]`;
}

/**
 * Register a MULTI-LINE pasted text blob; returns the preview chip to insert at
 * the cursor. Pasting identical content twice reuses the same chip. In the
 * astronomically-rare case two DIFFERENT pastes render an identical preview
 * (same head, tail, and line count), the chip is nudged with a `(k)`
 * discriminator so the registry stays 1:1 and neither paste can expand to the
 * other's text.
 */
export function registerPastedText(
  registry: PasteRegistry,
  fullText: string,
): string {
  let chip = textChip(fullText);
  const existing = registry.texts.get(chip);
  if (existing !== undefined && existing !== fullText) {
    let k = 2;
    while (
      registry.texts.has(withCounter(chip, k)) &&
      registry.texts.get(withCounter(chip, k)) !== fullText
    ) {
      k++;
    }
    chip = withCounter(chip, k);
  }
  registry.texts.set(chip, fullText);
  return chip;
}

/** Register a pasted image; returns the compact token to insert at the cursor. */
export function registerPastedImage(
  registry: PasteRegistry,
  attachment: PastedImageAttachment,
): string {
  const n = registry.nextImageId++;
  registry.images.set(n, attachment);
  return imageToken(n);
}

const IMAGE_TOKEN_AT_END_RE = /\[Image #\d+\]$/;
const IMAGE_TOKEN_AT_START_RE = /^\[Image #\d+\]/;

/** The longest registered text chip that `slice` ends with, or null. */
function textChipEndingAt(
  registry: PasteRegistry,
  slice: string,
): string | null {
  let best: string | null = null;
  for (const chip of registry.texts.keys()) {
    if (slice.endsWith(chip) && (best === null || chip.length > best.length))
      best = chip;
  }
  return best;
}

/** The longest registered text chip that `slice` starts with, or null. */
function textChipStartingAt(
  registry: PasteRegistry,
  slice: string,
): string | null {
  let best: string | null = null;
  for (const chip of registry.texts.keys()) {
    if (slice.startsWith(chip) && (best === null || chip.length > best.length))
      best = chip;
  }
  return best;
}

/**
 * The span `[start, end)` of a full token (image token or text chip)
 * immediately BEFORE `pos`, or null if there isn't one. Text chips are matched
 * against the registry's known preview strings rather than a grammar regex, so
 * a chip whose preview contains any characters is still detected exactly.
 */
export function tokenEndingAt(
  registry: PasteRegistry,
  text: string,
  pos: number,
): { start: number; end: number } | null {
  const before = text.slice(0, pos);
  const m = IMAGE_TOKEN_AT_END_RE.exec(before);
  if (m) return { start: pos - m[0].length, end: pos };
  const chip = textChipEndingAt(registry, before);
  return chip ? { start: pos - chip.length, end: pos } : null;
}

/** The span `[start, end)` of a full token immediately AFTER `pos`, or null. */
export function tokenStartingAt(
  registry: PasteRegistry,
  text: string,
  pos: number,
): { start: number; end: number } | null {
  const after = text.slice(pos);
  const m = IMAGE_TOKEN_AT_START_RE.exec(after);
  if (m) return { start: pos, end: pos + m[0].length };
  const chip = textChipStartingAt(registry, after);
  return chip ? { start: pos, end: pos + chip.length } : null;
}

/** Drop the registry entry for the token exactly spanning `text.slice(span.start, span.end)`, if any. */
export function dropTokenAt(
  registry: PasteRegistry,
  text: string,
  span: { start: number; end: number },
): void {
  const token = text.slice(span.start, span.end);
  if (registry.texts.delete(token)) return;
  const imgMatch = /^\[Image #(\d+)\]$/.exec(token);
  if (imgMatch) registry.images.delete(Number(imgMatch[1]));
}

/**
 * Drop every registry entry whose token no longer appears anywhere in `text` —
 * the minimum deletion contract: however a token got mangled (atomic
 * backspace, cursor-into-the-middle character erosion, retyping), a token that
 * isn't intact in the buffer at submit time can't resurrect stale content or
 * leak a dangling temp-file reference.
 */
export function pruneMissingTokens(
  registry: PasteRegistry,
  text: string,
): void {
  for (const chip of [...registry.texts.keys()]) {
    if (!text.includes(chip)) registry.texts.delete(chip);
  }
  for (const n of [...registry.images.keys()]) {
    if (!text.includes(imageToken(n))) registry.images.delete(n);
  }
}

export interface PasteSubmission {
  /** `text` with every text chip expanded inline to its full stored content, and every
   *  `[Image #N]` token replaced by a short literal note (the real bytes travel via `images`). */
  expandedText: string;
  /** Image attachments referenced by `[Image #N]` tokens still present in `text`, in submission order. */
  images: PastedImageAttachment[];
}

/**
 * Expand a submitted buffer's placeholder tokens for the model: text chips
 * inline, image tokens become an ordered attachment list. Tokens with no
 * registry entry (typed by hand, or already pruned) are left as literal text —
 * never silently dropped. Prunes stale entries first so the registry's state
 * matches exactly what this submission references.
 *
 * A single left-to-right scan: at each position it tries an image token, then
 * the longest registered chip that starts there, and otherwise copies one
 * character. Spliced-in content is NEVER rescanned, so pasted text that happens
 * to contain another token's literal string (`[Image #N]`, or a chip from an
 * earlier paste) can't trigger a spurious second expansion.
 */
export function expandPasteSubmission(
  registry: PasteRegistry,
  text: string,
): PasteSubmission {
  pruneMissingTokens(registry, text);
  const images: PastedImageAttachment[] = [];
  // Longest chip first so a chip that is a prefix of another wins the match.
  const chips = [...registry.texts.keys()].sort((a, b) => b.length - a.length);
  const imageAt = /\[Image #(\d+)\]/y; // sticky: anchored at lastIndex, no rescan
  let out = "";
  let i = 0;
  while (i < text.length) {
    imageAt.lastIndex = i;
    const m = imageAt.exec(text);
    if (m) {
      const img = registry.images.get(Number(m[1]));
      if (img) {
        images.push(img);
        out += "(attached image)";
        i += m[0].length;
        continue;
      }
      // Unregistered image token — fall through and copy it verbatim below.
    }
    const chip = chips.find((c) => text.startsWith(c, i));
    if (chip) {
      out += registry.texts.get(chip)!;
      i += chip.length;
      continue;
    }
    out += text[i];
    i++;
  }
  return { expandedText: out, images };
}
