// The mark beside a tool family on the Cost tab (`.frow .ti` in Tool
// families and `.fcell .ti` in Tool calls, the mockup's `catSvg`): what kind
// of work the calls were, at a glance, before the reader has read the name.
//
// Three rules, and they are the reason this is a table and not a free choice
// at each call site:
//
//  1. **One line-weight set, no emoji.** Every mark is a Lucide line icon at
//     the same stroke, so a column of them reads as one alphabet.
//  2. **The colour is the cell's, not the icon's.** The mark inherits
//     `currentColor` from the tile it sits in, so a new tool family can never
//     introduce a colour.
//  3. **The name is always beside it.** The mark is `aria-hidden` and the
//     family's name carries the meaning.
import {
  Bot,
  FileMinus,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListChecks,
  type LucideIcon,
  Notebook,
  Plug,
  Search,
  SquareChevronRight,
  Wrench,
  Zap,
} from "lucide-react";
import type { ToolGroup } from "./tool-detail";

/**
 * A mark per tool family. `shell` is a prompt inside a terminal, which is the
 * one icon a reader identifies without being taught it, and `skill` is the
 * bolt, because loading a skill is the one step that changes what the agent
 * can do rather than what it has done.
 */
const TOOL_ICONS: Readonly<Record<ToolGroup, LucideIcon>> = {
  shell: SquareChevronRight,
  read: FileText,
  edit: FilePen,
  create: FilePlus,
  delete: FileMinus,
  search: Search,
  web: Globe,
  skill: Zap,
  agent: Bot,
  plan: ListChecks,
  notebook: Notebook,
  mcp: Plug,
  tool: Wrench,
};

/**
 * The mark for a tool family. `.frow .ti svg` draws it at 11px and
 * `.fcell .ti svg` at 13px, so the cell that holds it names the size.
 */
export function ToolIcon({
  group,
  size = "sm",
}: {
  group: ToolGroup;
  size?: "sm" | "md";
}) {
  const Icon = TOOL_ICONS[group];
  return (
    <Icon
      aria-hidden="true"
      strokeWidth={1.75}
      className={`${size === "sm" ? "size-[11px]" : "size-[13px]"} shrink-0`}
    />
  );
}
