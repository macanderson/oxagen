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
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  FileMinusIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  LightningIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  NotebookIcon,
  NotePencilIcon,
  PlugIcon,
  RobotIcon,
  TerminalWindowIcon,
  WrenchIcon,
} from "@phosphor-icons/react/ssr";
import type { ToolGroup } from "./tool-detail";

/**
 * A mark per tool family. `shell` is a prompt inside a terminal, which is the
 * one icon a reader identifies without being taught it, and `skill` is the
 * bolt, because loading a skill is the one step that changes what the agent
 * can do rather than what it has done.
 */
const TOOL_ICONS: Readonly<Record<ToolGroup, PhosphorIcon>> = {
  shell: TerminalWindowIcon,
  read: FileTextIcon,
  edit: NotePencilIcon,
  create: FilePlusIcon,
  delete: FileMinusIcon,
  search: MagnifyingGlassIcon,
  web: GlobeIcon,
  skill: LightningIcon,
  agent: RobotIcon,
  plan: ListChecksIcon,
  notebook: NotebookIcon,
  mcp: PlugIcon,
  tool: WrenchIcon,
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
      className={`${size === "sm" ? "size-[11px]" : "size-[13px]"} shrink-0`}
    />
  );
}
