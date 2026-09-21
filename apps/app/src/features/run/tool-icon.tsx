// The mark beside a transcript line: what kind of thing this step was, at a
// glance, before the reader has read a word of it.
//
// Three rules, and they are the reason this is a table and not a free choice
// at each call site:
//
//  1. **One line-weight set, no emoji.** Every mark is a Lucide line icon at
//     the same stroke and size, so a column of them reads as one alphabet.
//     An emoji would bring its own colour, its own weight and its own
//     rendering per platform, and the column would look like a sticker sheet.
//  2. **The colour is the node's, not the icon's.** The mark inherits
//     `currentColor` from the step's name, which the transcript already
//     colours by node (`model` info, `deny` destructive, everything else
//     foreground). So the palette here is exactly the house palette, and a
//     new tool group can never introduce a colour. The icon carries the
//     *shape* difference; the node carries the colour difference.
//  3. **The name is always beside it.** The mark is an accelerator for a
//     reader scanning a long run, never the only thing that says what ran, so
//     it is `aria-hidden` and the tool's name carries the meaning.

import {
  Bot,
  FileMinus,
  FilePen,
  FilePlus,
  FileText,
  Flag,
  Globe,
  ListChecks,
  type LucideIcon,
  Notebook,
  Plug,
  Search,
  ShieldCheck,
  ShieldX,
  Sparkles,
  SquareChevronRight,
  Wrench,
  Zap,
} from "lucide-react";
import type { StepNode } from "./transcript-model";
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

/** A mark per non-tool step: a model call, a gate, a control frame, a refusal. */
const NODE_ICONS: Readonly<Record<StepNode, LucideIcon>> = {
  model: Sparkles,
  tool: Wrench,
  policy: ShieldCheck,
  control: Flag,
  deny: ShieldX,
};

/**
 * The mark for a step. A tool step is marked by its family; every other step
 * is marked by its node, so a model call, a policy decision and a refusal are
 * each told apart at the same glance a tool is.
 *
 * `deny` overrides the family on purpose: that a call was refused outranks
 * what it would have done, and it is the one thing a reader scanning for
 * trouble is scanning for.
 */
export function StepIcon({
  node,
  group,
}: {
  node: StepNode;
  group: ToolGroup | null;
}) {
  const Icon =
    node === "deny"
      ? NODE_ICONS.deny
      : group === null
        ? NODE_ICONS[node]
        : TOOL_ICONS[group];
  return (
    <Icon
      aria-hidden="true"
      strokeWidth={1.75}
      className="size-[13px] shrink-0 self-center"
    />
  );
}
