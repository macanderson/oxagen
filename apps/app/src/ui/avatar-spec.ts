// The designed-avatar spec (mockup `avatarHtml`/`avatarBody`): what a stored
// `avatar:v1:<json>` value can say, and the total parser that reads one.
//
// A person's avatar is one of three kinds. An `icon` is a Lucide glyph, the
// set the product ships, drawn at one line weight in the tone's ink. `initials`
// are up to six letters in one of three typefaces. A `photo` is an `https://`
// URL and is not a spec string at all: it is stored as the bare URL, the
// form every avatar-carrying contract already accepts.
//
// Tone is the only colour choice. Solid, soft and line are three relations to
// the theme (the foreground ink as a disc, a lifted panel, a hairline). Gold
// and gold-deep are the brand gold (#D4AF37) and its deep shade (#8A7223),
// the same in both themes. Each tone fixes its own glyph colour, so the five
// stay legible on ink and on paper alike and there is no combination that
// fails. No free colour and no gradient: the house scale and nothing else.
//
// This module is dependency-free on purpose: the renderer and the editor both
// import it into client bundles, and the contract's zod schema stays on the
// server. `SPEC_PREFIX` and `MAX_LEN` therefore mirror `AVATAR_SPEC_PREFIX` and
// `AVATAR_MAX_LEN` in packages/oxagen/src/avatar.ts rather than importing them.
// They stay module-local, and avatar.test.tsx proves the mirror holds through
// `parseAvatarValue` against the contract's own constants, so the two cannot
// drift without a red test.

/** Mirrors `AVATAR_SPEC_PREFIX` in packages/oxagen/src/avatar.ts. */
const SPEC_PREFIX = "avatar:v1:";
/** Mirrors `AVATAR_MAX_LEN`: the column's cap, so an oversized value is not parsed at all. */
const MAX_LEN = 512;

export const AVATAR_ICONS = [
  "rocket",
  "compass",
  "microscope",
  "stethoscope",
  "pencil-line",
  "receipt",
  "wrench",
  "flask-conical",
  "key-round",
  "package",
  "satellite",
  "bot",
  "bird",
  "bug",
  "sprout",
  "cog",
  "brain",
  "search",
  "radio-tower",
  "wand-sparkles",
  "brick-wall",
  "target",
  "folder-tree",
  "shield-check",
] as const;
export type AvatarIcon = (typeof AVATAR_ICONS)[number];

export const AVATAR_FONTS = ["sans", "serif", "mono"] as const;
export type AvatarFont = (typeof AVATAR_FONTS)[number];

export const AVATAR_TONES = [
  "solid",
  "soft",
  "line",
  "gold",
  "gold-deep",
] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

/** A monogram is at most six letters; the tile scales its type down to fit. */
export const INITIALS_MAX = 6;

export type DesignedAvatar =
  | { kind: "icon"; icon: AvatarIcon; tone: AvatarTone }
  | { kind: "initials"; text: string; font: AvatarFont; tone: AvatarTone };

/**
 * The emoji body the app stored under `avatar:v1:` before the W11 editor:
 * `{"emoji":"\u{1F98A}","bg":"#f59e0b","mode":"full"}`. Still readable, never
 * writable: the editor offers icons, monograms and photos and nothing else, so
 * no new value takes this shape.
 *
 * It is read because the rows are real: `avatarUrlSchema` accepted this body,
 * it is still accepted, and profiles, workspaces and agents hold it. Dropping
 * it from the parser turned every one of those into the initials fallback
 * without anyone editing anything.
 *
 * The stored `bg` is not read. It was a free hex colour, which the house scale
 * replaced; the glyph is the part that identifies the person, so it is drawn on
 * the `soft` tone like any other avatar the theme owns.
 */
interface LegacyEmojiAvatar {
  kind: "emoji";
  emoji: string;
}

export type AvatarValue =
  | { kind: "image"; url: string }
  | DesignedAvatar
  | LegacyEmojiAvatar
  | { kind: "none" };

const ICONS: readonly string[] = AVATAR_ICONS;
const FONTS: readonly string[] = AVATAR_FONTS;
const TONES: readonly string[] = AVATAR_TONES;

function isAvatarIcon(value: unknown): value is AvatarIcon {
  return typeof value === "string" && ICONS.includes(value);
}
function isAvatarFont(value: unknown): value is AvatarFont {
  return typeof value === "string" && FONTS.includes(value);
}
function isAvatarTone(value: unknown): value is AvatarTone {
  return typeof value === "string" && TONES.includes(value);
}

/** Two-letter initials for an avatar: first and last word, uppercased. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase();
}

/** The letters a monogram keeps: trimmed, upper-cased, cut at INITIALS_MAX. */
export function monogram(text: string): string {
  return text.trim().toUpperCase().slice(0, INITIALS_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function designedFrom(json: string): DesignedAvatar | LegacyEmojiAvatar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { kind, icon, text, font, tone, emoji } = parsed;
  // The legacy body names no kind and no tone; it is recognised by its emoji.
  if (kind === undefined && typeof emoji === "string" && emoji !== "")
    return { kind: "emoji", emoji };
  if (!isAvatarTone(tone)) return null;
  if (kind === "icon" && isAvatarIcon(icon)) return { kind, icon, tone };
  if (kind === "initials" && typeof text === "string" && isAvatarFont(font)) {
    const letters = monogram(text);
    return letters === "" ? null : { kind, text: letters, font, tone };
  }
  return null;
}

/** Reads a stored avatar value. Never throws: anything malformed is `none`. */
export function parseAvatarValue(
  value: string | null | undefined,
): AvatarValue {
  if (!value || value.length > MAX_LEN) return { kind: "none" };
  if (value.startsWith(SPEC_PREFIX))
    return designedFrom(value.slice(SPEC_PREFIX.length)) ?? { kind: "none" };
  if (value.startsWith("https://")) return { kind: "image", url: value };
  return { kind: "none" };
}

/** The stored form of a designed avatar. Key order is fixed so equal avatars are equal strings. */
export function serializeAvatar(avatar: DesignedAvatar): string {
  const body =
    avatar.kind === "icon"
      ? { kind: avatar.kind, icon: avatar.icon, tone: avatar.tone }
      : {
          kind: avatar.kind,
          text: monogram(avatar.text),
          font: avatar.font,
          tone: avatar.tone,
        };
  return `${SPEC_PREFIX}${JSON.stringify(body)}`;
}
