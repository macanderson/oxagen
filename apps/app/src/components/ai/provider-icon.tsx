/**
 * ProviderIcon — small inline brand SVG mark for each catalog {@link Vendor}.
 *
 * Dependency-free and server-safe (no client hooks, no `"use client"`): it is a
 * pure presentational component that renders a hand-rolled, brand-evocative
 * `<svg>` for the eight vendors surfaced by the model catalog. These marks are
 * clean geometric *approximations* — they read as the brand at small sizes
 * without copying trademarked path data. Unknown vendor strings fall back to a
 * neutral first-letter tile.
 *
 * Usage:
 *   <ProviderIcon vendor="anthropic" />               // default h-4 w-4
 *   <ProviderIcon vendor="openai" className="h-5 w-5" />
 */
import type * as React from "react";
import type { Vendor } from "@oxagen/ai/catalog";

/**
 * Brand accent colours, exported for callers that want to tint surrounding
 * chrome (e.g. a provider chip border) to match the mark.
 */
export const PROVIDER_ACCENT: Record<Vendor, string> = {
  anthropic: "#D4A27F", // warm clay
  openai: "#0D0D0D", // near-black knot
  google: "#4285F4", // Google blue (multi-colour mark below)
  xai: "#000000", // black X
  meta: "#0866FF", // Meta blue
  mistral: "#FF7000", // Mistral orange
  deepseek: "#4D6BFE", // DeepSeek blue
  bfl: "#111111", // Black Forest Labs dark
};

interface ProviderIconProps {
  vendor: Vendor;
  className?: string;
}

/** Shared props applied to every mark's root <svg>. */
const svgBase = {
  viewBox: "0 0 24 24",
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true as const,
  focusable: "false" as const,
};

/**
 * Per-vendor mark renderers. Each returns the inner geometry only; the wrapping
 * <svg> (with sizing className) is added by {@link ProviderIcon}.
 */
const MARKS: Record<Vendor, () => React.ReactElement> = {
  // Anthropic — the warm-clay "A" chevron / sunburst mark.
  anthropic: () => (
    <>
      <path
        d="M13.6 4h3.1l5.3 16h-3.3l-1.1-3.4h-5.6L10.8 20H7.6L13.6 4Zm-.6 4.3-1.9 5.6h3.8l-1.9-5.6Z"
        fill={PROVIDER_ACCENT.anthropic}
      />
      <path d="M6.9 4h3.2L4.8 20H1.6L6.9 4Z" fill={PROVIDER_ACCENT.anthropic} />
    </>
  ),
  // OpenAI — monochrome interlocked-knot flower approximation.
  openai: () => (
    <path
      d="M12 3a4.2 4.2 0 0 0-3.9 2.6A4.2 4.2 0 0 0 5 9.3a4.2 4.2 0 0 0 .6 5.1 4.2 4.2 0 0 0 .8 4.6A4.2 4.2 0 0 0 12 21a4.2 4.2 0 0 0 3.9-2.6 4.2 4.2 0 0 0 3.1-3.7 4.2 4.2 0 0 0-.6-5.1 4.2 4.2 0 0 0-.8-4.6A4.2 4.2 0 0 0 12 3Zm0 2.2 3.4 2v3.9L12 13.1 8.6 11.1V7.2L12 5.2Zm-5.2 4 .1.1v4l3.4 2v3.9a2 2 0 0 1-2.7-.8 2 2 0 0 1-.2-2.2 2 2 0 0 1-.9-2.7 2 2 0 0 1 .3-4.3Zm10.4 0a2 2 0 0 1 .3 4.3 2 2 0 0 1-.9 2.7 2 2 0 0 1-.2 2.2 2 2 0 0 1-2.7.8v-3.9l3.4-2v-4l.1-.1Z"
      fill={PROVIDER_ACCENT.openai}
    />
  ),
  // Google — the four-colour "G".
  google: () => (
    <>
      <path
        d="M21.6 12.2c0-.7-.06-1.4-.18-2.05H12v3.9h5.4a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 3-4.33 3-7.37Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.97-.9 6.62-2.43l-3.23-2.5c-.9.6-2.05.96-3.39.96-2.6 0-4.8-1.76-5.59-4.12H3.08v2.58A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.41 13.9a6 6 0 0 1 0-3.8V7.53H3.08a10 10 0 0 0 0 8.95l3.33-2.58Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.86A10 10 0 0 0 3.08 7.53l3.33 2.58C7.2 7.74 9.4 5.98 12 5.98Z"
        fill="#EA4335"
      />
    </>
  ),
  // xAI — the sharp "X" mark.
  xai: () => (
    <path
      d="M3 3h4.3l4.7 6.6L17 3h4l-6.7 8.9L21 21h-4.3l-4.9-6.9L6.9 21H3l7-9.3L3 3Z"
      fill={PROVIDER_ACCENT.xai}
    />
  ),
  // Meta — the blue infinity loop.
  meta: () => (
    <path
      d="M7 6.2c-2.5 0-4 2.5-4 5.5S4.4 17.8 7 17.8c1.6 0 2.8-1 4.2-3.1l.8-1.2.8 1.2c1.4 2.1 2.6 3.1 4.2 3.1 2.6 0 4-2.6 4-6.1S19.6 6.2 17 6.2c-1.7 0-3 1.1-4.6 3.6l-.4.6-.4-.6C10 7.3 8.7 6.2 7 6.2Zm0 2.4c.8 0 1.6.8 2.8 2.7l.5.7-.5.7c-1.2 1.9-2 2.7-2.8 2.7-1.1 0-1.8-1.4-1.8-3.2S5.9 8.6 7 8.6Zm10 0c1.1 0 1.8 1.6 1.8 3.4S18.1 15.4 17 15.4c-.8 0-1.6-.8-2.8-2.7l-.5-.7.5-.7c1.2-1.9 2-2.7 2.8-2.7Z"
      fill={PROVIDER_ACCENT.meta}
    />
  ),
  // Mistral — the orange stacked-bars glyph.
  mistral: () => (
    <>
      <rect x="3" y="4" width="4" height="4" fill="#F7D046" />
      <rect x="17" y="4" width="4" height="4" fill="#F7D046" />
      <rect x="3" y="8" width="4" height="4" fill="#F2A73B" />
      <rect x="9" y="8" width="4" height="4" fill="#F2A73B" />
      <rect x="17" y="8" width="4" height="4" fill="#F2A73B" />
      <rect x="3" y="12" width="4" height="4" fill="#EE792F" />
      <rect x="9" y="12" width="4" height="4" fill="#EE792F" />
      <rect x="17" y="12" width="4" height="4" fill="#EE792F" />
      <rect x="3" y="16" width="4" height="4" fill="#EB5829" />
      <rect x="17" y="16" width="4" height="4" fill="#EB5829" />
    </>
  ),
  // DeepSeek — the blue whale-curve mark.
  deepseek: () => (
    <path
      d="M20.5 5.4c-.3-.15-.5.1-.72.28-.08.06-.14.14-.2.22-.55.6-1.2.99-2.05.94-1.24-.07-2.3.32-3.24 1.27-.2-1.17-.86-1.87-1.86-2.32-.53-.24-1.06-.47-1.43-.98-.26-.36-.33-.77-.46-1.16-.08-.24-.16-.48-.44-.52-.3-.05-.42.2-.54.4-.48.83-.66 1.75-.64 2.68.04 2.1.93 3.77 2.7 4.96.2.14.25.28.19.48-.12.4-.26.8-.38 1.2-.08.26-.2.31-.48.2A6.1 6.1 0 0 1 6.6 11.4c-.5-.85-.95-1.73-1.53-2.53-.14-.19-.28-.4-.55-.36-.28.05-.32.32-.4.55-.18.63-.25 1.28-.24 1.94.03 1.86.8 3.35 2.34 4.4 1.76 1.2 3.71 1.44 5.76 1.05.16-.03.2.02.24.15.1.35.24.7.36 1.05.28.83.56 1.66.68 2.53.06.44.26.53.66.4a5.9 5.9 0 0 0 3.63-3.44c.6-1.5.65-3.1.44-4.68-.04-.3.02-.42.32-.53a4.1 4.1 0 0 0 2.4-2.42c.15-.4.24-.83.36-1.24.1-.34-.05-.5-.38-.38Zm-6.6 9.9c-.13.06-.25.1-.34-.05-.24-.36-.46-.72-.6-1.13-.05-.14.05-.19.15-.24.5-.24 1-.24 1.5.02.13.06.27.14.24.32-.02.5-.55.85-.95 1.08Z"
      fill={PROVIDER_ACCENT.deepseek}
    />
  ),
  // Black Forest Labs — a dark forest / stylised "F" mark.
  bfl: () => (
    <>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4"
        fill={PROVIDER_ACCENT.bfl}
      />
      <path d="M8 7h8v2.4H10.4v2.4H15v2.4h-4.6V17H8V7Z" fill="#FAFAFA" />
    </>
  ),
};

/** Neutral fallback tile for an unrecognised vendor string. */
function FallbackTile({
  vendor,
  className,
}: {
  vendor: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={
        "inline-grid shrink-0 place-items-center rounded border border-border bg-muted/60 font-mono text-[10px] font-semibold uppercase text-muted-foreground " +
        (className ?? "h-4 w-4")
      }
    >
      {vendor.charAt(0) || "?"}
    </span>
  );
}

/**
 * Render the brand mark for a catalog {@link Vendor}. Sizing is controlled by
 * `className` (default `h-4 w-4`) so callers can scale the mark up or down.
 */
export function ProviderIcon({
  vendor,
  className,
}: ProviderIconProps): React.ReactElement {
  const Mark = MARKS[vendor];
  if (!Mark) {
    // `vendor` is typed as Vendor, but a caller may pass an out-of-catalog
    // string at runtime — degrade to a neutral first-letter tile.
    return <FallbackTile vendor={vendor} className={className} />;
  }
  return (
    <svg {...svgBase} className={className ?? "h-4 w-4"}>
      <Mark />
    </svg>
  );
}
