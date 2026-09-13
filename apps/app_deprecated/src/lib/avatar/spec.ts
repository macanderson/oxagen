/**
 * spec.ts — the canonical avatar value format, shared by every entity that
 * carries an avatar (user, org, workspace, agent).
 *
 * A stored avatar value is a nullable string, either:
 *   - a photo: an `https://` URL (existing blob CDN behavior, unchanged), or
 *   - a designed avatar: the literal prefix `avatar:v1:` followed by strict
 *     JSON `{"emoji":"🦊","bg":"#f59e0b","mode":"full"}`.
 *
 * This module is pure and dependency-free so it can be imported from Server
 * Components, route handlers, and the data layer alike without pulling in any
 * React/DOM surface. `parseAvatarValue` never throws — malformed input always
 * degrades to `{ kind: "none" }` so a bad value in the database can never
 * crash a render.
 */

/** Designed-avatar color mode — see `EntityAvatar` for the rendering rules. */
export type AvatarMode = "full" | "mono-light" | "mono-dark";

export type AvatarSpec =
  | { kind: "image"; url: string }
  | { kind: "designed"; emoji: string; bg: string; mode: AvatarMode }
  | { kind: "none" };

/** Hard cap on the serialized avatar value, matching the storage column. */
export const AVATAR_VALUE_MAX_LENGTH = 512;

const DESIGNED_PREFIX = "avatar:v1:";

// Canonical (stored) hex must be exactly lowercase `#rrggbb` — parsing is
// strict and rejects uppercase so a hand-written or corrupted value never
// silently round-trips. `serializeDesignedAvatar` accepts either case on the
// way in and normalizes to lowercase on the way out.
const HEX_CANONICAL_RE = /^#[0-9a-f]{6}$/;
const HEX_INPUT_RE = /^#[0-9a-fA-F]{6}$/;

const MODES: readonly AvatarMode[] = ["full", "mono-light", "mono-dark"];

function isMode(value: unknown): value is AvatarMode {
  return (
    typeof value === "string" && (MODES as readonly string[]).includes(value)
  );
}

/**
 * A "single emoji" is validated loosely by length rather than by grapheme
 * parsing: ZWJ sequences and skin-tone modifiers can run to several UTF-16
 * code units (e.g. "🧑‍🚒" or "👋🏽"), so we just cap the string length rather
 * than assert a single Unicode grapheme (no dependency-free way to do that
 * correctly across environments).
 */
function isValidEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

interface DesignedPayload {
  emoji: string;
  bg: string;
  mode: AvatarMode;
}

/** Parses + validates the JSON tail of a `avatar:v1:` value. Never throws. */
function parseDesignedPayload(json: string): DesignedPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const { emoji, bg, mode } = parsed as Record<string, unknown>;

  if (!isValidEmoji(emoji)) return null;
  if (typeof bg !== "string" || !HEX_CANONICAL_RE.test(bg)) return null;
  if (!isMode(mode)) return null;

  return { emoji, bg, mode };
}

/**
 * Parses a stored avatar value into a discriminated `AvatarSpec`. Strict and
 * total: any malformed input (bad JSON, wrong prefix content, bad hex, bad
 * mode, empty/oversized emoji, non-https URL, oversized string) degrades to
 * `{ kind: "none" }` instead of throwing.
 */
export function parseAvatarValue(value: string | null | undefined): AvatarSpec {
  if (!value) return { kind: "none" };
  if (value.length > AVATAR_VALUE_MAX_LENGTH) return { kind: "none" };

  if (value.startsWith(DESIGNED_PREFIX)) {
    const payload = parseDesignedPayload(value.slice(DESIGNED_PREFIX.length));
    if (!payload) return { kind: "none" };
    return {
      kind: "designed",
      emoji: payload.emoji,
      bg: payload.bg,
      mode: payload.mode,
    };
  }

  if (isHttpsUrl(value)) return { kind: "image", url: value };

  return { kind: "none" };
}

/** True iff `value` is a well-formed `avatar:v1:` designed-avatar string. */
export function isDesignedAvatarValue(
  value: string | null | undefined,
): boolean {
  return parseAvatarValue(value).kind === "designed";
}

export interface SerializeDesignedAvatarInput {
  emoji: string;
  /** `#rrggbb`, either case — normalized to lowercase in the output. */
  bg: string;
  mode: AvatarMode;
}

/**
 * Validates and serializes a designed-avatar input into the canonical
 * `avatar:v1:{...}` string (lowercase hex, stable `emoji`/`bg`/`mode` key
 * order). Throws a descriptive `Error` on invalid input — callers (e.g. the
 * avatar maker's Save button) should validate their own form fields before
 * calling this so the throw path is unreachable in normal use.
 */
export function serializeDesignedAvatar(
  input: SerializeDesignedAvatarInput,
): string {
  if (!isValidEmoji(input.emoji)) {
    throw new Error(
      "Invalid avatar emoji: must be a non-empty string of at most 16 UTF-16 code units",
    );
  }
  if (typeof input.bg !== "string" || !HEX_INPUT_RE.test(input.bg)) {
    throw new Error(
      `Invalid avatar background color: expected #rrggbb hex, got "${input.bg}"`,
    );
  }
  if (!isMode(input.mode)) {
    throw new Error(
      `Invalid avatar mode: expected one of ${MODES.join(", ")}, got "${String(input.mode)}"`,
    );
  }

  const bg = input.bg.toLowerCase();
  // Stable key order (emoji, bg, mode) — matches the canonical example in the
  // format spec so byte-for-byte output is deterministic across callers.
  const json = JSON.stringify({ emoji: input.emoji, bg, mode: input.mode });
  const serialized = `${DESIGNED_PREFIX}${json}`;

  if (serialized.length > AVATAR_VALUE_MAX_LENGTH) {
    throw new Error(
      `Serialized avatar value exceeds ${AVATAR_VALUE_MAX_LENGTH} characters (got ${serialized.length})`,
    );
  }

  return serialized;
}
