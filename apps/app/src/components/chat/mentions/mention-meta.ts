import type { LucideIcon } from "lucide-react";
import {
  ArrowRightLeft,
  Bot,
  CircleDot,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  Server,
  Sparkles,
  Wrench,
  Zap,
} from "lucide-react";
import type { MentionType } from "@oxagen/ai/mentions";

/** Per-type presentation for mention chips and the picker menu. */
export interface MentionTypeMeta {
  icon: LucideIcon;
  /** Tailwind text-* tint applied to the type icon. */
  iconClassName: string;
}

export const MENTION_TYPE_META: Record<MentionType, MentionTypeMeta> = {
  repository: { icon: FolderGit2, iconClassName: "text-blue-500" },
  branch: { icon: GitBranch, iconClassName: "text-emerald-500" },
  file: { icon: FileCode2, iconClassName: "text-sky-500" },
  directory: { icon: Folder, iconClassName: "text-amber-500" },
  agent: { icon: Bot, iconClassName: "text-fuchsia-500" },
  skill: { icon: Sparkles, iconClassName: "text-lime-500" },
  tool: { icon: Wrench, iconClassName: "text-orange-500" },
  mcp_server: { icon: Server, iconClassName: "text-teal-500" },
  capability: { icon: Zap, iconClassName: "text-yellow-600" },
  node: { icon: CircleDot, iconClassName: "text-cyan-600" },
  edge: { icon: ArrowRightLeft, iconClassName: "text-rose-500" },
};

/**
 * A row returned by /api/reference-search — structurally identical to the
 * `search_references` contract's result row, retyped over `MentionType` so
 * client code stays on the dep-free `@oxagen/ai/mentions` union.
 */
export interface MentionSearchResult {
  type: MentionType;
  slug: string;
  location: string;
  label: string;
  description: string | null;
  properties: Record<string, unknown>;
}
