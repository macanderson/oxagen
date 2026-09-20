// The one agent identity component (mockup `agentCard`): an avatar, the agent
// key and a line under it, in the list layout (a table cell) or the detail
// layout (the agent page's header). The mockup's Trust and Spend pills are cut
// (#2969 closed), so no layout draws a score.
import type { ReactNode } from "react";
import { mono } from "./control-styles";

const AVATAR = {
  list: "size-7 text-[11px]",
  detail: "size-14 text-lg",
} as const;

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
      className="flex min-w-0 items-center gap-2.5 text-left"
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
        className={`flex min-w-0 flex-col leading-snug ${layout === "list" ? "w-48 max-w-60" : "max-w-full"}`}
      >
        {agentKey === null ? (
          <span className="text-muted-foreground">{notRecorded}</span>
        ) : (
          <span
            title={agentKey}
            className={`${mono} ${layout === "detail" ? "break-words text-lg font-semibold" : "truncate"}`}
          >
            {agentKey}
          </span>
        )}
        <span className="truncate text-xs text-muted-foreground">{sub}</span>
      </span>
    </span>
  );
}
