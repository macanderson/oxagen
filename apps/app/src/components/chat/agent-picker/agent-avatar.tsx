"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { parseAvatarValue } from "@/lib/avatar/spec";
import { EntityAvatar } from "@/components/avatar/entity-avatar";

/**
 * agent-avatar.tsx — the one way to render an agent's avatar across the picker,
 * gallery, composer chip, and code-agent setup step.
 *
 * Renders BOTH forms an agent's `avatarUrl` can take — an https:// image URL and
 * the platform designed-avatar spec (`avatar:v1:<json>`) — by delegating to the
 * shared `EntityAvatar` renderer (never hand-rolling the emoji tile). When an
 * agent has no real avatar (null, or a malformed spec), it falls back to
 * deterministic initials on a slug-hued gradient — a stable, recognizable mark
 * per agent, not a generic bot icon.
 */

export type AgentAvatarSize = "sm" | "md" | "lg";

// Fallback-tile sizing + glyph text, in lockstep with EntityAvatar's sm/md/lg.
const FALLBACK_TILE: Record<AgentAvatarSize, string> = {
  sm: "size-6 text-xs",
  md: "size-8 text-sm",
  lg: "size-12 text-lg",
};

/**
 * Deterministic hue (0–359) from a slug, so an agent's fallback tile is stable
 * across renders and surfaces. Simple rolling hash — collisions are cosmetic.
 */
export function hueFromSlug(slug: string): number {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash * 31 + slug.charCodeAt(i)) % 360;
  }
  return hash;
}

/** First letters of up to the first two words of `name`, uppercased. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.charAt(0) ?? "?").toUpperCase();
  return `${parts[0]?.charAt(0) ?? ""}${parts[1]?.charAt(0) ?? ""}`.toUpperCase();
}

export interface AgentAvatarProps {
  /** https:// URL, `avatar:v1:<json>` designed spec, or null when unset. */
  avatarUrl: string | null;
  /** Display name — drives initials + the accessible label. */
  name: string;
  /** Slug — drives the deterministic fallback hue (stable per agent). */
  slug: string;
  size?: AgentAvatarSize;
  shape?: "circle" | "square";
  className?: string;
}

export function AgentAvatar({
  avatarUrl,
  name,
  slug,
  size = "sm",
  shape = "square",
  className,
}: AgentAvatarProps) {
  // A real avatar (image or designed spec) → the shared renderer.
  if (parseAvatarValue(avatarUrl).kind !== "none") {
    return (
      <EntityAvatar
        value={avatarUrl}
        name={name}
        size={size}
        shape={shape}
        className={className}
      />
    );
  }

  // No real avatar → deterministic initials on a slug-hued gradient.
  const hue = hueFromSlug(slug);
  const shapeClass = shape === "circle" ? "rounded-full" : "rounded-md";
  return (
    <div
      role="img"
      aria-label={`${name} avatar`}
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold text-white",
        shapeClass,
        FALLBACK_TILE[size],
        className,
      )}
      style={{
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 40) % 360} 60% 45%))`,
      }}
    >
      <span aria-hidden="true">{initialsOf(name)}</span>
    </div>
  );
}
