/**
 * entity-avatar.tsx — the one way to render any entity's avatar (user, org,
 * workspace, agent). Reads the canonical avatar value (`../../lib/avatar/spec.ts`)
 * and renders one of three states:
 *
 *   - image     → the uploaded/OAuth photo, via next/image.
 *   - designed  → an emoji tile on a background color, in one of three
 *                 color modes (full / mono-light / mono-dark).
 *   - none      → initials on a muted tile, matching the existing
 *                 OrgSwitcher/UserSwitcher fallback convention.
 *
 * No hooks — safe to render from a Server Component as well as client code.
 */
import NextImage from "next/image";
import { cn } from "@/lib/utils";
import { parseAvatarValue, type AvatarMode } from "@/lib/avatar/spec";

export type EntityAvatarShape = "circle" | "square";
export type EntityAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

export interface EntityAvatarProps {
  /** The canonical stored avatar value (image URL, designed string, or null/undefined). */
  value?: string | null;
  /** Entity display name — drives the initials fallback and the accessible label. */
  name: string;
  shape?: EntityAvatarShape;
  size?: EntityAvatarSize;
  className?: string;
}

// Tailwind size classes + matching pixel dimensions (for next/image) + emoji /
// initials font-size, kept in lockstep per size step.
const SIZE_CLASS: Record<EntityAvatarSize, string> = {
  xs: "size-5",
  sm: "size-6",
  md: "size-8",
  lg: "size-12",
  xl: "size-16",
};

const SIZE_PX: Record<EntityAvatarSize, number> = {
  xs: 20,
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
};

const GLYPH_TEXT_CLASS: Record<EntityAvatarSize, string> = {
  xs: "text-[10px]",
  sm: "text-xs",
  md: "text-sm",
  lg: "text-xl",
  xl: "text-3xl",
};

// Designed-avatar color mode → CSS filter applied to the emoji glyph.
//   full       — the emoji renders in its native color.
//   mono-light — a white silhouette (for use on dark/colored backgrounds).
//   mono-dark  — a black silhouette (for use on light backgrounds).
const MODE_FILTER: Record<AvatarMode, string | undefined> = {
  full: undefined,
  "mono-light": "brightness(0) invert(1)",
  "mono-dark": "brightness(0)",
};

/** First letters of up to the first two words of `name`, uppercased. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.charAt(0) ?? "?").toUpperCase();
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts[1]?.charAt(0) ?? "";
  return `${first}${last}`.toUpperCase();
}

export function EntityAvatar({
  value,
  name,
  shape = "circle",
  size = "md",
  className,
}: EntityAvatarProps) {
  const spec = parseAvatarValue(value);
  const shapeClass = shape === "circle" ? "rounded-full" : "rounded-md";
  const label = `${name} avatar`;

  if (spec.kind === "image") {
    const px = SIZE_PX[size];
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden bg-muted",
          shapeClass,
          SIZE_CLASS[size],
          className,
        )}
      >
        <NextImage
          src={spec.url}
          alt={label}
          width={px}
          height={px}
          className="size-full object-cover"
        />
      </div>
    );
  }

  if (spec.kind === "designed") {
    return (
      <div
        role="img"
        aria-label={label}
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden",
          shapeClass,
          SIZE_CLASS[size],
          className,
        )}
        style={{ backgroundColor: spec.bg }}
      >
        <span
          aria-hidden="true"
          className={cn("leading-none", GLYPH_TEXT_CLASS[size])}
          style={{ filter: MODE_FILTER[spec.mode] }}
        >
          {spec.emoji}
        </span>
      </div>
    );
  }

  // kind === "none" — initials fallback.
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center justify-center bg-muted font-semibold uppercase text-muted-foreground",
        shapeClass,
        SIZE_CLASS[size],
        GLYPH_TEXT_CLASS[size],
        className,
      )}
    >
      <span aria-hidden="true">{initialsOf(name)}</span>
    </div>
  );
}
