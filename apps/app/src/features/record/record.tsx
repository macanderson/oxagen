// One published context record (#3395; ADR-061; MC spec §10.2;
// mockups/pages/record.md), presented by its kind.
//
// The label is the headline and the breadcrumb's last step, the slug under it
// is the address that never changes (ADR-173), and the commit and the
// counters read as the metadata they are. The statement is editable in a real
// source editor, and saving opens a pull request: a published record is
// changed the way it was published.
//
// The record is read through the repository binding, out of
// `.oxagen/rules/<lineage>.toml` on the production branch, with the registry
// mirror as a fallback. Provenance is the publishing commit from git, never a
// column.
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { RecordKind } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { PageRecord } from "@/features/shell";
import { getSession } from "@/server/session";
import type { WsCtx } from "@/server/viewer";
import { panel, panelBody, panelHeader } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { KindPanel } from "./kind-panel";
import { LineagePanel } from "./lineage-panel";
import { PageFailure } from "./page-failure";
import { Related } from "./related";
import { LINEAGE, recordLink, type RecordAt } from "./view";
import { RecordWorkbench } from "./workbench";

/** The proposal states that mean a change is open on this lineage right now. */
const OPEN_STATUSES = new Set([
  "proposed",
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
]);

/**
 * Whether this viewer's role may revise at all. It mirrors the gate
 * `revise_context_record` enforces (INV-29), so the proposal dialog says so
 * rather than offering a submit that is refused. The handler remains the
 * authority: this only decides what the page shows.
 */
function canRevise(ctx: WsCtx): boolean {
  const orgAdmin = ctx.orgRole === "owner" || ctx.orgRole === "admin";
  const wsWriter = ctx.wsRole === "owner" || ctx.wsRole === "member";
  return orgAdmin || wsWriter;
}

/** The design's `.sk` shimmer (globals.css), the one every skeleton draws. */
const bar = "skeleton rounded-md";

/**
 * The loading state (mockup `skeleton()`): four tiles and a panel of rows,
 * textless, under the shell. The page must never flash a statement, a count
 * or a commit that the read has not answered with yet.
 */
export function RecordLoading() {
  const t = useTranslations("record");
  return (
    <div
      role="status"
      data-state="loading"
      aria-busy="true"
      aria-label={t("loading")}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(175px,1fr))]">
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className="skeleton h-16 rounded-[11px]" />
        ))}
      </div>
      <div className={panel}>
        <div className={panelHeader}>
          <div className={`${bar} h-4 w-44`} />
        </div>
        <div className={`${panelBody} flex flex-col gap-2`}>
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <div key={row} className={`${bar} h-9`} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The related panel makes its own read and suspends on its own, so a slow
 * list of the other records of this kind never holds back the record the
 * route names.
 */
async function RelatedPanel({
  ctx,
  source,
  at,
  kind,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: RecordAt;
  kind: RecordKind | null;
}) {
  if (kind === null)
    return <Related at={at} workspace={ctx.wsName} kind={null} read={null} />;
  const read = await source.steering.records(ctx, { kind, offset: 0 });
  return <Related at={at} workspace={ctx.wsName} kind={kind} read={read} />;
}

function RelatedFallback() {
  const t = useTranslations("record");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      {[0, 1, 2].map((row) => (
        <div key={row} className={`${bar} h-16`} />
      ))}
    </div>
  );
}

/** A read's value, or null when it did not answer. */
function valueOf<T>(read: Read<T>): T | null {
  return read.ok ? read.value : null;
}

export async function Record({
  ctx,
  source,
  lineage,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The route's lineage segment, already percent-decoded by the router. */
  lineage: string;
}) {
  // An address that could never name a record is a 404 before a read is made.
  if (!LINEAGE.test(lineage)) notFound();
  const at: RecordAt = { org: ctx.orgSlug, ws: ctx.wsSlug, lineage };
  const readAt = instantOfRead();
  const [read, proposals, freshness] = await Promise.all([
    source.steering.record(ctx, lineage),
    source.steering.proposals(ctx, { offset: 0, lineage }),
    source.steering.freshness(ctx),
  ]);
  // A lineage neither the repository nor the registry holds is a 404, not a
  // page error: the route named a record that does not exist.
  if (!read.ok && read.reason === "error" && read.status === 404) notFound();
  if (!read.ok) {
    const session = await getSession();
    return (
      <Failure
        read={read}
        at={at}
        orgName={ctx.orgName}
        viewer={{
          name: session?.user.name ?? session?.user.email ?? ctx.userId,
          role: `workspace.${ctx.wsRole}`,
        }}
        readAt={readAt}
      />
    );
  }
  const detail = read.value;
  const kind = detail.record.kind;
  // The conflict note counts every published record, which is the list's
  // total with no kind filter; only a constraint prints it.
  const published =
    kind === "constraint"
      ? valueOf(await source.steering.records(ctx, { kind: null, offset: 0 }))
      : null;
  const open = proposals.ok
    ? (proposals.value.proposals.find(
        (proposal) =>
          proposal.lineage === lineage && OPEN_STATUSES.has(proposal.status),
      ) ?? null)
    : null;
  const fresh = valueOf(freshness);
  const repository = fresh?.repository ?? null;
  return (
    <>
      <PageRecord
        route="steering"
        id={lineage}
        label={detail.record.label ?? detail.record.title}
      />
      <RecordWorkbench
        at={at}
        detail={detail}
        repository={repository}
        canWrite={canRevise(ctx)}
        pendingBranch={
          open === null ? null : (open.pr?.branch ?? `context/${lineage}`)
        }
        lineagePanel={<LineagePanel detail={detail} repository={repository} />}
        kindPanel={
          <KindPanel
            detail={detail}
            bundleVersion={fresh?.version ?? null}
            publishedTotal={published?.total ?? null}
          />
        }
        related={
          <Suspense fallback={<RelatedFallback />}>
            <RelatedPanel ctx={ctx} source={source} at={at} kind={kind} />
          </Suspense>
        }
      />
    </>
  );
}

/** The failed read, with the instant formatted in the viewer's zone. */
function Failure({
  read,
  at,
  orgName,
  viewer,
  readAt,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
  at: RecordAt;
  orgName: string;
  viewer: { name: string; role: string };
  readAt: string;
}) {
  const format = useFormatter();
  return (
    <PageFailure
      read={read}
      org={at.org}
      orgName={orgName}
      ws={at.ws}
      viewer={viewer}
      retry={recordLink(at)}
      readAt={format.dateTime(new Date(readAt), {
        dateStyle: "medium",
        timeStyle: "long",
      })}
    />
  );
}

/**
 * The instant the reads were attempted, taken before them. It is declared
 * outside the component because a component may not read a clock during
 * render (the React purity lint), and it is the instant a failure is stamped
 * with so a reader reports when the read failed rather than when the element
 * drew.
 */
function instantOfRead(): string {
  return new Date().toISOString();
}
