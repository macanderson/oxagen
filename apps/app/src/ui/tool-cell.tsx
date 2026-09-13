// The one component every tool display goes through: the category glyph, the
// human label first and the API name second, or swapped when the viewer picked
// API names. Identity is the icon; the category has no hue of its own.
import {
  ClipboardList,
  CreditCard,
  Database,
  Eye,
  FilePen,
  GitBranch,
  KeyRound,
  MessageSquareText,
  Server,
  Terminal,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cx } from "./cx";
import { classifyToolName, humanizeToolName, parseToolId } from "./tool-name";
import type { ToolCategory } from "./vocabulary";

export const TOOL_CATEGORY_ICON = {
  read: Eye,
  query: Database,
  record: ClipboardList,
  message: MessageSquareText,
  file: FilePen,
  exec: Terminal,
  vcs: GitBranch,
  infra: Server,
  access: KeyRound,
  finance: CreditCard,
} as const satisfies Record<ToolCategory, unknown>;

export type ToolCellProps = {
  /** `server__local_name` or `server__local_name@version`. */
  tool: string;
  /** The registry's label; derived from the name when absent. */
  label?: string | undefined;
  /** The registry's category; derived from the name's verb when absent. */
  category?: ToolCategory | undefined;
  /** Secondary detail appended to the second line. */
  sub?: string | undefined;
  /** Which name leads. */
  names?: "label" | "api";
  size?: "sm" | "md";
};

export function ToolCell({
  tool,
  label,
  category,
  sub,
  names = "label",
  size = "md",
}: ToolCellProps) {
  const t = useTranslations("ui");
  const { name, version } = parseToolId(tool);
  const shownLabel = label ?? humanizeToolName(name);
  const cat = category ?? classifyToolName(name);
  const Icon = TOOL_CATEGORY_ICON[cat];
  const categoryLabel = t(`toolCategory.${cat}.label`);
  const api = (
    <span className="font-mono">
      {name}
      {version ? (
        <span className="text-muted-foreground">@{version}</span>
      ) : null}
    </span>
  );
  const apiFirst = names === "api";
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-2"
      data-testid="tool-cell"
      data-category={cat}
      title={t("toolCell.title", {
        api: version ? `${name}@${version}` : name,
        label: shownLabel,
        category: categoryLabel,
      })}
    >
      <span
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground",
          size === "sm" ? "size-6" : "size-7",
        )}
      >
        <Icon
          aria-hidden
          focusable={false}
          className="size-3.5"
          strokeWidth={1.8}
        />
        <span className="sr-only">{categoryLabel}</span>
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span
          className={cx(
            "truncate font-medium text-foreground",
            size === "sm" ? "text-xs" : "text-sm",
            apiFirst && "font-mono",
          )}
        >
          {apiFirst ? api : shownLabel}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {apiFirst ? shownLabel : api}
          {sub ? ` · ${sub}` : null}
        </span>
      </span>
    </span>
  );
}
