// The one agent identity component (mockup `agentCard`): an avatar, the agent
// key and a line under it, in the list layout (a table cell), the compact
// layout (a bordered pill on a run's header and summary) or the detail layout
// (the agent page's header). The mockup's Trust and Spend pills are cut
// (#2969 closed), so no layout draws a score.
import type { ReactNode } from "react";
import { mono } from "./control-styles";

const AVATAR = {
  list: "size-7 text-[11px]",
  compact: "size-[30px] text-[11px]",
  detail: "size-14 text-lg",
} as const;

/**
 * `.agc-compact { padding:5px 11px 5px 6px; border:1px solid var(--border);
 * border-radius:10px; background:var(--ink) }` and `.agc .agid .sub {
 * font-size:11.5px; color:var(--dim) }`.
 */
const COMPACT =
  "inline-flex max-w-full rounded-[10px] border border-border bg-background py-[5px] pl-1.5 pr-[11px]";

export function AgentCard({
  agentKey,
  notRecorded,
  sub,
  layout = "list",
}: {
  /** `org_ns.ws_ns.slug`; null when the store names no agent. */
  agentKey: string | null;
  /** The translated words for a key the store did not record. */
  notRecorded: string;
  sub: ReactNode;
  layout?: keyof typeof AVATAR;
}) {
  const slug = agentKey?.split(".").at(-1) ?? "";
  return (
    <span
      data-layout={layout}
      className={`flex min-w-0 items-center gap-2.5 text-left ${layout === "compact" ? COMPACT : ""}`}
    >
      {agentKey === null ? null : (
        <span
          aria-hidden="true"
          className={`inline-flex shrink-0 items-center justify-center rounded-[30%] border border-border bg-muted font-semibold uppercase ${AVATAR[layout]}`}
        >
          {slug.slice(0, 2)}
        </span>
      )}
      <span
        className={`flex min-w-0 flex-col leading-snug ${layout === "list" ? "w-48 max-w-60" : layout === "compact" ? "max-w-[280px] leading-[1.3]" : "max-w-full"}`}
      >
        {agentKey === null ? (
          <span className="text-muted-foreground">{notRecorded}</span>
        ) : (
          <span
            title={agentKey}
            className={`${mono} ${layout === "detail" ? "break-words text-lg font-semibold" : layout === "compact" ? "truncate text-[12px] text-foreground" : "truncate"}`}
          >
            {agentKey}
          </span>
        )}
        <span
          className={`truncate ${layout === "compact" ? "text-[11.5px] text-dim" : "text-xs text-muted-foreground"}`}
        >
          {sub}
        </span>
      </span>
    </span>
  );
}
