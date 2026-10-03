// One work item (roadmap mockups/pages/work-item.md, the design of record at
// ADR-226's pin): where a person decides what happens to it. They approve its
// brief, send it to one agent, watch the send until a runtime claims it,
// review the result on the pull request's head commit, and accept it, return
// it, stop it, or close it. Every fact a decision rests on sits on this page
// with its time and its source.
//
// The page reads the item (get_work_item) and the agents that can take a send
// (list_work_targets) together. An item the workspace does not hold is a 404.
// A refused or failed item read replaces the body with its state and keeps the
// shell. A failed targets read only holds Send back, with its reason. Once the
// item answers, the page reads its change set (get_change_set) by the item's
// public id, which the URL does not carry (ADR-292). A failed change set read
// is named in its own panel.
//
// The page's words are Phase 1's: Claimed, and Accepted by a person. No word
// on it claims a verdict. A cost the runtime did not send reads unknown, every
// acceptance names the commit it was given on, and the item's own text stays
// data.
import { notFound } from "next/navigation";
import type { ChangeSet } from "@/data/contracts/changes";
import type { WorkItemDetail, WorkTargetList } from "@/data/contracts/work";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import { PageRecord } from "@/features/shell";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { useFormatter } from "@/ui/formatter";
import { BriefPanel } from "./brief-panel";
import { ChangesPanel } from "./changes-panel";
import { CostPanel, HistoryPanel } from "./cost-history";
import { DeliveryPanel } from "./delivery-panel";
import { WorkItemHead } from "./head";
import { WorkItemReadFailure } from "./read-failure";
import { ReviewPanel } from "./review-panel";
import { SourcePanel, TriagePanel } from "./source-triage";
import { reviewSend } from "./view";

type At = { org: string; ws: string };

function Loaded({
  detail,
  targets,
  changes,
  at,
  dialog,
}: {
  detail: WorkItemDetail;
  targets: WorkTargetList | null;
  changes: Read<ChangeSet>;
  at: At;
  dialog: "send" | null;
}) {
  const status = detail.item.status;
  const showDelivery =
    detail.sends.length > 0 || status === "ready" || status === "send_rejected";
  const review = reviewSend(detail);
  const showCost = detail.sends.some((send) => send.runs.length > 0);
  return (
    <div data-testid="work-item" data-status={status} className="flex flex-col gap-3.5">
      <WorkItemHead
        detail={detail}
        targets={targets}
        org={at.org}
        ws={at.ws}
        dialog={dialog}
      />
      <div className="grid border-t border-border pt-[18px] md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:gap-x-7">
        <SourcePanel detail={detail} />
        <TriagePanel detail={detail} at={at} />
      </div>
      <BriefPanel detail={detail} />
      {showDelivery ? <DeliveryPanel detail={detail} at={at} /> : null}
      {review === null ? null : <ReviewPanel detail={detail} send={review} at={at} />}
      <ChangesPanel detail={detail} read={changes} at={at} />
      {showCost ? <CostPanel detail={detail} at={at} /> : null}
      <HistoryPanel detail={detail} />
    </div>
  );
}

/**
 * When the read came back, which the error state prints. It sits outside the
 * component because a component may not read the clock while it renders; the
 * page is an async server component, so this runs once per request.
 */
function instantAfterRead(): Date {
  return new Date();
}

export async function WorkItemPage({
  ctx,
  source,
  item,
  dialog,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The workspace's number for the item, as the URL names it (WI-12). */
  item: string;
  /** A dialog the URL asks to open on arrival: `?dialog=send` opens Send when Send is allowed. */
  dialog: "send" | null;
}) {
  const [read, targets] = await Promise.all([
    source.work.get(ctx, item),
    source.work.targets(ctx),
  ]);
  const readAt = instantAfterRead();
  const at: At = { org: ctx.orgSlug, ws: ctx.wsSlug };
  if (!read.ok) {
    // An item this workspace does not hold is a 404, the answer any other
    // address that names nothing gets.
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <Failure read={read} at={at} item={item} readAt={readAt.toISOString()} />
    );
  }
  // A thrown read folds to the work page's own read error, so the Changes
  // panel says the read failed rather than the page throwing.
  const changes = await source.changes
    .changeSet(ctx, "work_item", read.value.item.id)
    .catch(() =>
      readError(PAGE_FAILURES.work.error.code, PAGE_FAILURES.work.error.status),
    );
  return (
    <>
      <PageRecord
        route="work"
        id={read.value.item.number}
        label={read.value.item.title}
      />
      <Loaded
        detail={read.value}
        targets={targets.ok ? targets.value : null}
        changes={changes}
        at={at}
        dialog={dialog}
      />
    </>
  );
}

function Failure({
  read,
  at,
  item,
  readAt,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
  at: At;
  item: string;
  readAt: string;
}) {
  const format = useFormatter();
  return (
    <WorkItemReadFailure
      read={read}
      org={at.org}
      ws={at.ws}
      retry={routes.workItem(at.org, at.ws, item)}
      readAt={format.dateTime(new Date(readAt), {
        dateStyle: "medium",
        timeStyle: "long",
      })}
    />
  );
}
