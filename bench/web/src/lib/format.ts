import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className combiner (standard `cn` helper). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a millisecond duration as a compact human string (e.g. "4.2s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

/** Format a token count compactly (e.g. "3.4k", "1.2M"). */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** Format a 0..1 ratio as a whole-number percentage (e.g. "92%"). */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Format a 0..1 ratio with one decimal place (e.g. "92.4%"). */
export function formatPercent1(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Format a USD amount compactly (e.g. "$0.27", "$12.40"). */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
