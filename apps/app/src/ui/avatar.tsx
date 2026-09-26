"use client";
// The one avatar renderer in the app (mockup `avatarHtml`). A stored avatar
// value is EITHER an `https://` URL OR a designed-avatar spec string
// `avatar:v1:{...}` (src/ui/avatar-spec.ts), the two forms `avatarUrlSchema`
// (packages/oxagen/src/avatar.ts) accepts everywhere an avatar is written. A
// surface that tests for `https://` alone shows initials to a person whose
// profile holds a perfectly valid designed avatar, and does it silently.
//
// Parsing is total: every malformed value degrades to the initials tile
// rather than throwing, because a bad row in the database must never take a
// render down.
//
// A value being well formed is not the same as an image existing. The contract
// checks the `https://` prefix and nothing else — it cannot, at write time,
// know that the host will 404, expire the object, or refuse the hotlink — so a
// URL that never loads is persistable and would otherwise leave a broken image
// in the shell until the person edited their profile again. The image branch
// falls back to the initials tile on `error`. It remembers WHICH url failed
// rather than a boolean, so editing the field to a different URL tries again
// with no effect and no stale flag to reset.
//
// People are round; agents, workspaces and organizations are squircles. The
// tone lives on the record: one of three relations to the theme (solid, soft,
// line) or the brand gold in its bright or deep shade. Each tone fixes its own
// glyph colour, so there is no combination that fails on ink or on paper.
import {
  Bird,
  Bot,
  Brain,
  BrickWall,
  Bug,
  Cog,
  Compass,
  FlaskConical,
  FolderTree,
  KeyRound,
  type LucideIcon,
  Microscope,
  Package,
  PencilLine,
  RadioTower,
  Receipt,
  Rocket,
  Satellite,
  Search,
  ShieldCheck,
  Sprout,
  Stethoscope,
  Target,
  WandSparkles,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import {
  type AvatarFont,
  type AvatarIcon,
  type AvatarTone,
  parseAvatarValue,
} from "./avatar-spec";

export const AVATAR_GLYPHS: Record<AvatarIcon, LucideIcon> = {
  rocket: Rocket,
  compass: Compass,
  microscope: Microscope,
  stethoscope: Stethoscope,
  "pencil-line": PencilLine,
  receipt: Receipt,
  wrench: Wrench,
  "flask-conical": FlaskConical,
  "key-round": KeyRound,
  package: Package,
  satellite: Satellite,
  bot: Bot,
  bird: Bird,
  bug: Bug,
  sprout: Sprout,
  cog: Cog,
  brain: Brain,
  search: Search,
  "radio-tower": RadioTower,
  "wand-sparkles": WandSparkles,
  "brick-wall": BrickWall,
  target: Target,
  "folder-tree": FolderTree,
  "shield-check": ShieldCheck,
};

const TONE_CLASS: Record<AvatarTone, string> = {
  solid: "bg-foreground text-background border-foreground",
  soft: "bg-secondary text-foreground border-border",
  line: "bg-transparent text-foreground border-input-border",
  gold: "bg-gold text-on-gold border-gold",
  "gold-deep": "bg-gold-deep text-on-gold-deep border-gold-deep",
};

const FONT_CLASS: Record<AvatarFont, string> = {
  sans: "font-sans font-semibold",
  serif: "font-serif font-medium",
  mono: "font-mono font-semibold",
};

/**
 * The type size for a monogram, as a fraction of the tile: one letter fills
 * half of it, six sit at a fifth, so the longest monogram still clears the
 * edge at 18px.
 */
function initialsScale(letters: number): number {
  if (letters <= 1) return 0.5;
  if (letters === 2) return 0.42;
  if (letters === 3) return 0.36;
  if (letters === 4) return 0.28;
  if (letters === 5) return 0.23;
  return 0.19;
}

export type AvatarShape = "person" | "agent";

/**
 * The avatar for a person or an agent. Decorative in every state: the name it
 * belongs to is rendered as text beside it, or carried by the trigger's
 * `aria-label`, so the image has an empty alt and the tiles are hidden from
 * the accessibility tree.
 */
export function Avatar({
  value,
  initials,
  size = 28,
  shape = "person",
  fallbackTone = "soft",
  fallbackFont = "sans",
  testId,
}: {
  /** The stored value: an https URL, a designed-avatar string, or nothing. */
  value: string | null | undefined;
  /** What the initials tile shows when the value names no avatar. */
  initials: string;
  /** The tile's side in CSS pixels; the glyph scales with it. */
  size?: number;
  shape?: AvatarShape;
  /** The initials tile's tone when the value names no avatar. */
  fallbackTone?: AvatarTone;
  /** The initials tile's type when the value names no avatar. */
  fallbackFont?: AvatarFont;
  testId?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const spec = parseAvatarValue(value);
  const radius = shape === "person" ? "rounded-full" : "rounded-[27%]";
  const box = `inline-grid flex-none place-items-center overflow-hidden border box-border align-middle leading-none ${radius}`;
  const side = { width: size, height: size };

  if (spec.kind === "image" && spec.url !== failedUrl)
    return (
      /* An arbitrary remote avatar cannot be in next.config's image allowlist,
         and this is a chrome ornament, not page content worth optimising. */
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={spec.url}
        alt=""
        data-testid={testId}
        data-avatar="image"
        style={side}
        className={`${box} border-transparent object-cover`}
        onError={() => {
          setFailedUrl(spec.url);
        }}
      />
    );

  if (spec.kind === "icon") {
    const Glyph = AVATAR_GLYPHS[spec.icon];
    return (
      <span
        aria-hidden="true"
        data-testid={testId}
        data-avatar="icon"
        data-icon={spec.icon}
        data-tone={spec.tone}
        style={side}
        className={`${box} ${TONE_CLASS[spec.tone]}`}
      >
        <Glyph
          strokeWidth={1.8}
          style={{ width: "56%", height: "56%" }}
          aria-hidden
        />
      </span>
    );
  }

  // The emoji body stored before the W11 editor. Read-only: the editor cannot
  // produce one, but a person who set an emoji years ago still sees it rather
  // than their initials. Drawn on `soft` because the body's own `bg` was a free
  // hex colour, which the house scale replaced.
  if (spec.kind === "emoji")
    return (
      <span
        aria-hidden="true"
        data-testid={testId}
        data-avatar="emoji"
        data-tone="soft"
        style={{ ...side, fontSize: Math.round(size * 0.58) }}
        className={`${box} ${TONE_CLASS.soft}`}
      >
        {spec.emoji}
      </span>
    );

  const text = spec.kind === "initials" ? spec.text : initials;
  const tone: AvatarTone = spec.kind === "initials" ? spec.tone : fallbackTone;
  const font: AvatarFont = spec.kind === "initials" ? spec.font : fallbackFont;
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-avatar="initials"
      data-tone={tone}
      data-font={font}
      style={{
        ...side,
        fontSize: Math.round(size * initialsScale(text.length)),
        letterSpacing: "0.02em",
      }}
      className={`${box} ${TONE_CLASS[tone]} ${FONT_CLASS[font]}`}
    >
      {text}
    </span>
  );
}
