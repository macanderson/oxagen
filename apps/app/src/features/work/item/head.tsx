// The Work item head (roadmap mockups/src/work.js `workItemView()`): the
// eyebrow, the item's title as the page's one heading, a line of facts (where
// it came from, who asked, when it arrived, and its status beside its dot),
// one line that says what it waits for, and the actions on the right with the
// primary last. A viewer whose roles admit no action reads one note that says
// who acts here, and every action reads disabled with the same reason.
//
// The title and the requester come from outside the workspace. They render as
// text, never as markup.
import { useTranslations } from "next-intl";
import type { WorkItemDetail, WorkTargetList } from "@/data/contracts/work";
import { parseGitHubUrl } from "@/shared/github-url";
import { eyebrow, linkText } from "@/ui/control-styles";
import { GitHubLink } from "@/ui/navigation";
import { WaitLine, WorkStatusBadge } from "../words";
import { ItemActions } from "./item-actions";
import { useWhen } from "./phrases";
import { itemData } from "./view";

export function WorkItemHead({
  detail,
  targets,
  org,
  ws,
  dialog,
}: {
  detail: WorkItemDetail;
  targets: WorkTargetList | null;
  org: string;
  ws: string;
  dialog: "send" | null;
}) {
  const t = useTranslations("workItem.head");
  const when = useWhen();
  const item = detail.item;
  const source = item.sourceUrl === null ? null : parseGitHubUrl(item.sourceUrl);
  const origin = t(`origins.${item.origin}`);
  const readsOnly = !detail.viewer.canControl && !detail.viewer.canApprove;
  return (
    <header
      data-testid="work-item-head"
      className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className={`${eyebrow} mb-1`}>{t("eyebrow")}</p>
        <h1 className="min-w-0 text-2xl font-bold leading-tight tracking-[-0.015em] text-foreground [overflow-wrap:anywhere]">
          {item.title}
        </h1>
        <div
          data-testid="work-item-facts"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground"
        >
          {source === null ? (
            <span data-testid="work-item-source">{origin}</span>
          ) : (
            <GitHubLink to={source} data-testid="work-item-source" className={linkText}>
              {origin}
            </GitHubLink>
          )}
          {item.requester === null ? null : (
            <span data-testid="work-item-requester">
              {t("requestedBy", { name: item.requester })}
            </span>
          )}
          <span>{t("arrived", { at: when(item.arrivedAt) })}</span>
          <span data-testid="work-item-status">
            <WorkStatusBadge status={item.status} />
          </span>
        </div>
        <p data-testid="work-item-wait" className="max-w-[72ch] pt-1">
          <WaitLine wait={item.wait} />
        </p>
        {readsOnly ? (
          <p
            role="note"
            data-testid="work-viewer-note"
            className="mt-1.5 max-w-[72ch] border-l-2 border-dashed border-border pl-2 text-[12.5px] text-muted-foreground"
          >
            {t("viewerNote")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 sm:max-w-[50%]">
        <ItemActions
          org={org}
          ws={ws}
          detail={itemData(detail)}
          targets={targets}
          dialog={dialog}
        />
      </div>
    </header>
  );
}
