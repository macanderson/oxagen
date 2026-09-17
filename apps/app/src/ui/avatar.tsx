// The one avatar renderer in the app. A stored avatar value is not just an
// image URL: `avatarUrlSchema` (packages/oxagen/src/avatar.ts), the schema
// every avatar-carrying contract shares, accepts EITHER an `https://` URL OR
// the designed-avatar spec string `avatar:v1:{"emoji":"🦊","bg":"#f59e0b",
// "mode":"full"}`. A surface that tests for `https://` alone shows initials to
// a person whose profile holds a perfectly valid designed avatar, and does it
// silently — which is what the Account dialog did before this file existed.
//
// Parsing is total: every malformed value degrades to `none` (the initials
// tile) rather than throwing, because a bad row in the database must never
// take a render down. The prefix is asserted against the contract's own
// `AVATAR_SPEC_PREFIX` in avatar.test.tsx, so the two cannot drift; it is
// re-declared here rather than imported so a client bundle does not pull zod
// in for a 52px ornament.

/** Designed-avatar colour mode: the glyph in its own colours, or a silhouette. */
export type AvatarMode = "full" | "mono-light" | "mono-dark";

export type AvatarValue =
  | { kind: "image"; url: string }
  | { kind: "designed"; emoji: string; bg: string; mode: AvatarMode }
  | { kind: "none" };

/** Mirrors `AVATAR_SPEC_PREFIX` in packages/oxagen/src/avatar.ts (asserted in the test). */
const DESIGNED_PREFIX = "avatar:v1:";
/** Mirrors `AVATAR_MAX_LEN`: the column's cap, so an oversized value is not parsed at all. */
const MAX_LEN = 512;

const HEX = /^#[0-9a-f]{6}$/;
const MODES: readonly string[] = ["full", "mono-light", "mono-dark"];

/**
 * A "single emoji" is capped by length rather than grapheme-parsed: a ZWJ
 * sequence or a skin-tone modifier runs to several UTF-16 code units, and
 * there is no dependency-free way to count graphemes correctly everywhere.
 */
function isEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16;
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function isMode(value: unknown): value is AvatarMode {
  return typeof value === "string" && MODES.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function designedFrom(json: string): AvatarValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { emoji, bg, mode } = parsed;
  if (!isEmoji(emoji) || !isHex(bg) || !isMode(mode)) return null;
  return { kind: "designed", emoji, bg, mode };
}

/** Reads a stored avatar value. Never throws: anything malformed is `none`. */
export function parseAvatarValue(
  value: string | null | undefined,
): AvatarValue {
  if (!value || value.length > MAX_LEN) return { kind: "none" };
  if (value.startsWith(DESIGNED_PREFIX))
    return (
      designedFrom(value.slice(DESIGNED_PREFIX.length)) ?? { kind: "none" }
    );
  if (value.startsWith("https://")) return { kind: "image", url: value };
  return { kind: "none" };
}

/** `full` keeps the emoji's own colours; the mono modes render it as a silhouette. */
const MODE_FILTER: Record<AvatarMode, string | undefined> = {
  full: undefined,
  "mono-light": "brightness(0) invert(1)",
  "mono-dark": "brightness(0)",
};

/**
 * The avatar beside a name. Decorative in every state — the name it belongs to
 * is always rendered as text next to it — so the image carries an empty alt and
 * the two tiles are hidden from the accessibility tree.
 */
export function Avatar({
  value,
  initials,
  className = "size-13 text-base",
  testId,
}: {
  /** The stored value: an https URL, a designed-avatar string, or null. */
  value: string | null;
  /** What the initials tile shows when the value names no avatar. */
  initials: string;
  /** Size and glyph scale; the shape and layout are fixed. */
  className?: string;
  testId?: string;
}) {
  const spec = parseAvatarValue(value);
  const box = `flex-none overflow-hidden rounded-full ${className}`;

  if (spec.kind === "image")
    return (
      /* An arbitrary remote avatar cannot be in next.config's image allowlist,
         and this is a chrome ornament, not page content worth optimising. */
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={spec.url}
        alt=""
        data-testid={testId}
        data-avatar="image"
        className={`${box} object-cover`}
      />
    );

  if (spec.kind === "designed")
    return (
      <span
        aria-hidden="true"
        data-testid={testId}
        data-avatar="designed"
        style={{ backgroundColor: spec.bg }}
        className={`grid place-items-center ${box}`}
      >
        <span
          className="leading-none"
          style={{ filter: MODE_FILTER[spec.mode] }}
        >
          {spec.emoji}
        </span>
      </span>
    );

  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-avatar="initials"
      className={`grid place-items-center bg-secondary font-semibold text-secondary-foreground ${box}`}
    >
      {initials}
    </span>
  );
}
