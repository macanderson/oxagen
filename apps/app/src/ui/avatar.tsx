// Avatars for people and agents: one record shape, stored on the record itself
// (initials, a Lucide glyph, or a photo) in one of three house tones. There is
// no free colour and no gradient, so no avatar can fall outside the palette.
// People are round and agents are squircles, so the two never read alike.
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
import Image from "next/image";
import { useTranslations } from "next-intl";
import { cx } from "./cx";

export const AVATAR_ICONS = {
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
} as const;
export type AvatarIconName = keyof typeof AVATAR_ICONS;

export type AvatarTone = "solid" | "soft" | "line";
export type AvatarFont = "sans" | "serif" | "mono";

export type AvatarValue =
  | { kind: "initials"; text: string; font?: AvatarFont; tone?: AvatarTone }
  | { kind: "icon"; icon: AvatarIconName; tone?: AvatarTone }
  | { kind: "photo"; src: string };

export type AvatarProps = {
  avatar: AvatarValue | null;
  shape?: "person" | "agent";
  /** Pixel size of the square. */
  size?: number;
  /** The name it stands for. Omit when the name is printed beside it (the avatar is then decorative). */
  label?: string;
  className?: string;
};

const TONE: Record<AvatarTone, string> = {
  solid: "bg-foreground text-background",
  soft: "border border-border bg-muted text-foreground",
  line: "border border-foreground/60 bg-transparent text-foreground",
};

const FONT: Record<AvatarFont, string> = {
  sans: "font-sans",
  serif: "font-serif",
  mono: "font-mono",
};

/** Initials shrink as they grow: one letter at half the box, three at about a third. */
export function initialsFontSize(text: string, size: number): number {
  const ratio = text.length >= 3 ? 0.36 : text.length === 2 ? 0.42 : 0.5;
  return Math.round(size * ratio);
}

export function Avatar({
  avatar,
  shape = "person",
  size = 28,
  label,
  className,
}: AvatarProps) {
  const t = useTranslations("ui.avatar");
  const value: AvatarValue = avatar ?? {
    kind: "initials",
    text: t("fallback"),
    tone: "soft",
  };
  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);
  const frame = cx(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden",
    shape === "person" ? "rounded-full" : "rounded-[30%]",
    className,
  );
  const box = { width: size, height: size };

  if (value.kind === "photo")
    return (
      <span
        {...a11y}
        className={frame}
        style={box}
        data-testid="avatar"
        data-kind="photo"
      >
        <Image
          src={value.src}
          alt=""
          width={size}
          height={size}
          unoptimized
          className="size-full object-cover"
        />
      </span>
    );

  if (value.kind === "icon") {
    const Icon = AVATAR_ICONS[value.icon];
    return (
      <span
        {...a11y}
        className={cx(frame, TONE[value.tone ?? "soft"])}
        style={box}
        data-testid="avatar"
        data-kind="icon"
      >
        <Icon
          aria-hidden
          focusable={false}
          strokeWidth={1.8}
          style={{ width: size * 0.56, height: size * 0.56 }}
        />
      </span>
    );
  }

  const text = value.text.slice(0, 3);
  return (
    <span
      {...a11y}
      className={cx(
        frame,
        TONE[value.tone ?? "soft"],
        FONT[value.font ?? "sans"],
        "font-semibold leading-none",
      )}
      style={{ ...box, fontSize: initialsFontSize(text, size) }}
      data-testid="avatar"
      data-kind="initials"
    >
      {text}
    </span>
  );
}
