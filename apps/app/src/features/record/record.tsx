// One published context record (#3395; ADR-061; MC spec §10.2), presented by
// its kind.
//
// The statement is the record, so the statement is the headline, and the
// lineage, the commit and the counters read as the metadata they are. The
// statement is editable in a real source editor, and saving opens a pull
// request: a published record is changed the way it was published.
//
// The record is read through the repository binding, out of
// `.oxagen/rules/<lineage>.toml` on the production branch, with the registry
// mirror as a fallback. Deleting the mirror row still renders this page.
// Provenance is the publishing commit from git, never a column.
import { type ReactNode, Suspense } from "react";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { RecordDetail, RecordKind } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { PageRecord } from "@/features/shell";
import type { WsCtx } from "@/server/viewer";
import { panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Header } from "./header";
import { KindPanel } from "./kind-panel";
import { LineagePanel } from "./lineage-panel";
import { PageFailure } from "./page-failure";
import { Related } from "./related";
import { StatementEditor } from "./statement-editor";
import { LINEAGE, recordLink, type RecordAt } from "./view";

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
 * `revise_context_record` enforces (INV-29), so the gold action is disabled
 * rather than offered and then refused. The handler remains the authority:
 * this only decides what the page shows.
 */
function canRevise(ctx: WsCtx): boolean {
  const orgAdmin = ctx.orgRole === "owner" || ctx.orgRole === "admin";
  const wsWriter = ctx.wsRole === "owner" || ctx.wsRole === "member";
  return orgAdmin || wsWriter;
}

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
      {/* Textless on purpose: the page must never flash a statement, a count
          or a commit that the read has not answered with yet. */}
      <div className="flex flex-col gap-3">
        <div className="h-3 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-8 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className={`${panel} flex flex-col gap-3 p-5`}>
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div
              key={row}
              className="h-5 animate-pulse rounded bg-muted motion-reduce:animate-none"
            />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1].map((block) => (
            <div key={block} className={`${panel} flex flex-col gap-3 p-5`}>
              {[0, 1, 2, 3].map((row) => (
                <div
                  key={row}
                  className="h-4 animate-pulse rounded bg-muted motion-reduce:animate-none"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Loaded({
  at,
  detail,
  canWrite,
  pendingBranch,
  related,
}: {
  at: RecordAt;
  detail: RecordDetail;
  canWrite: boolean;
  pendingBranch: string | null;
  related: ReactNode;
}) {
  const path = `${detail.record.path ?? `.oxagen/rules/${at.lineage}.toml`} · statement`;
  return (
    <div className="flex flex-col gap-6">
      <PageRecord route="steering" id={at.lineage} />
      <Header at={at} detail={detail} pendingBranch={pendingBranch} />
      {/* Two columns on a wide screen, one on a narrow one, with the editor
          first in source order so a phone puts the statement above the kind
          panel exactly as the mockup asks. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <StatementEditor
            at={at}
            path={path}
            statement={detail.record.statement}
            canWrite={canWrite}
            pendingBranch={pendingBranch}
          />
          <LineagePanel detail={detail} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <KindPanel detail={detail} />
          {related}
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
  if (kind === null) return <Related at={at} kind={null} read={null} />;
  const read = await source.steering.records(ctx, { kind, offset: 0 });
  return <Related at={at} kind={kind} read={read} />;
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
  const [read, proposals] = await Promise.all([
    source.steering.record(ctx, lineage),
    source.steering.proposals(ctx, { offset: 0, lineage }),
  ]);
  // A lineage neither the repository nor the registry holds is a 404, not a
  // page error: the route named a record that does not exist.
  if (!read.ok && read.reason === "error" && read.status === 404) notFound();
  if (!read.ok) return <Failure read={read} at={at} readAt={readAt} />;
  const open = proposals.ok
    ? (proposals.value.proposals.find(
        (proposal) =>
          proposal.lineage === lineage && OPEN_STATUSES.has(proposal.status),
      ) ?? null)
    : null;
  return (
    <Loaded
      at={at}
      detail={read.value}
      canWrite={canRevise(ctx)}
      pendingBranch={open?.pr?.branch ?? null}
      related={
        <Suspense fallback={<RelatedFallback />}>
          <RelatedPanel
            ctx={ctx}
            source={source}
            at={at}
            kind={read.value.record.kind}
          />
        </Suspense>
      }
    />
  );
}

function RelatedFallback() {
  const t = useTranslations("record");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      className={`${panel} flex flex-col gap-3 p-5`}
    >
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="h-12 animate-pulse rounded bg-muted motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

/** The failed read, with the instant formatted in the viewer's zone. */
function Failure({
  read,
  at,
  readAt,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
  at: RecordAt;
  readAt: string;
}) {
  const format = useFormatter();
  return (
    <PageFailure
      read={read}
      org={at.org}
      ws={at.ws}
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
