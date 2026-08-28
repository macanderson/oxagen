"use client";
/**
 * CapabilityIcon — renders a named Lucide icon inside a rounded colored
 * container.  Only the icons actually referenced by the marketplace are
 * imported so we don't pull in the entire lucide-react barrel.
 *
 * Usage:
 *   <CapabilityIcon iconName="brain-circuit" color="#f59e0b" size={32} />
 *
 * The icon name should be the kebab-case Lucide name (e.g. "brain-circuit").
 * Unknown names fall back to the <Package> icon.
 */

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import {
  BrainCircuit,
  BookOpen,
  ImagePlus,
  NotebookPen,
  Package,
  PenTool,
  Plug,
  Sparkles,
  Video,
  Layers,
  Zap,
  Globe,
  Database,
  FileText,
  Code2,
  Music,
  BarChart2,
  Mail,
  Calendar,
  Search,
  MessageSquare,
} from "lucide-react";

// ── Icon registry (kebab-case name → LucideIcon) ─────────────────────────────
// Add new entries here as new icon names appear in catalog rows.  Keeping this
// explicit (rather than a dynamic import) avoids pulling in the whole barrel.

const ICON_MAP: Record<string, LucideIcon> = {
  "brain-circuit": BrainCircuit,
  "book-open": BookOpen,
  "image-plus": ImagePlus,
  "notebook-pen": NotebookPen,
  package: Package,
  "pen-tool": PenTool,
  plug: Plug,
  sparkles: Sparkles,
  video: Video,
  layers: Layers,
  zap: Zap,
  globe: Globe,
  database: Database,
  "file-text": FileText,
  code2: Code2,
  code: Code2,
  music: Music,
  "bar-chart-2": BarChart2,
  mail: Mail,
  calendar: Calendar,
  search: Search,
  "message-square": MessageSquare,
};

// ── Per-type defaults ────────────────────────────────────────────────────────

export const PLUGIN_TYPE_DEFAULTS: Record<
  "mcp_server" | "integration" | "agent_capability" | "agent_skill" | "knowledge_source",
  { iconName: string; color: string }
> = {
  mcp_server: { iconName: "plug", color: "#3b82f6" },
  integration: { iconName: "package", color: "#4E6A7A" },
  agent_capability: { iconName: "brain-circuit", color: "#f59e0b" },
  agent_skill: { iconName: "sparkles", color: "#10b981" },
  knowledge_source: { iconName: "book-open", color: "#0ea5e9" },
};

// ── Component ────────────────────────────────────────────────────────────────

interface CapabilityIconProps {
  iconName: string;
  color?: string;
  /** Container size in px (icon scales to ~60% of container). Default 32. */
  size?: number;
  className?: string;
}

export function CapabilityIcon({
  iconName,
  color = "#777782",
  size = 32,
  className,
}: CapabilityIconProps) {
  const Icon = ICON_MAP[iconName] ?? Package;
  const iconSize = Math.round(size * 0.5);

  return (
    <span
      className={`inline-flex items-center justify-center rounded flex-shrink-0 ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
      }}
      aria-hidden="true"
    >
      <Icon
        style={{ width: iconSize, height: iconSize, color: "#ffffff" }}
        aria-hidden="true"
      />
    </span>
  );
}

// ── Helper: resolve icon+color from a catalog icons array entry ──────────────

/**
 * Given the first entry from `srv.icons`, returns which render path to use:
 *   - "image"  → src is a URL / data URI → render <Image>
 *   - "lucide" → src is a Lucide icon name → render <CapabilityIcon>
 *   - "default"→ no icon entry → caller should use the per-type default
 */
export function resolveIconEntry(
  icons: Array<{ src: string; color?: string }> | undefined,
): { type: "image"; src: string } | { type: "lucide"; iconName: string; color?: string } | { type: "default" } {
  const first = icons?.[0];
  if (!first) return { type: "default" };
  if (/^https?:\/\//.test(first.src) || first.src.startsWith("data:")) {
    return { type: "image", src: first.src };
  }
  return { type: "lucide", iconName: first.src, color: first.color };
}
