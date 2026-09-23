// One mandate (#2957; ADR-059; the design's `pMandate`): the delegated
// financial authority an agent holds — its limits, what has been settled and
// reserved against it, the grant that created it, and the ledger of every draw.
//
// The page reads `get_mandate` and nothing else. Every figure on it is the
// ledger's own accounting (INV-10): `authority` carries, per measure, the
// per-call and per-period limits, what the period has settled, what calls in
// flight have reserved, and what is left. Nothing here sums the table beneath
// it, which is the point of the rule that a header is a rollup of its rows —
// the rollup is the record's, and the rows are a view of it that a search may
// narrow without a tile moving.
//
// **Four tiles, one number and one basis line each, and each tile lists every
// measure.** The design's mandate has one money measure and a calls cap, so the
// tiles read as four figures there; a mandate limiting two measures shows both
// under each heading, through the same `MandateAuthorityList` the two ledger
// tables use. That is the shared presentation, not a local one: a mandate's
// authority is a list of measures with their own windows, and every surface that
// tabulates it had already dropped the window once each.
//
// **A not-loaded state replaces the body, never the shell.** The header goes
// with the body, because a header naming a mandate the reader may not see is
// itself a disclosure; the shell, its navigation and its search stay, so a
// reader who cannot see this mandate can still leave.
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { OrgRole } from "@/data/contracts/common";
import type { MandateDetail, MandateRow } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { eyebrow, linkText, mono, panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { MandateAuthorityList } from "@/ui/mandate-authority";
import { SafeLink } from "@/ui/navigation";
import { MandateGrant } from "./grant";
import { MandateLedger } from "./ledger";
import { MandateActions } from "./mandate-actions";
import { MandateReadFailure } from "./read-failure";
import {
  type MandateAt,
  MANDATE_ID,
  mandateLink,
  type MandateView,
  parseMandateView,
} from "./view";

/**
 * A mandate's status as a dot and a word. `active` is the only status that
 * authorizes anything; `draft` is a request nobody has granted, and `expired`
 * and `revoked` are history. None of the three is drawn in gold: gold is
 * identity on this product and never encodes state, so the hue sits on the dot
 * and the word carries the fact.
 */
const STATUS_DOT: Record<MandateRow["status"], string> = {
  draft: "bg-warning",
  active: "bg-success",
  expired: "bg-muted-foreground",
  revoked: "bg-destructive",
};

function MandateStatusBadge({ status }: { status: MandateRow["status"] }) {
  const t = useTranslations("mandate.status");
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${STATUS_DOT[status]}`}
      />
      {t(status)}
    </span>
  );
}

function Tile({
  heading,
  basis,
  children,
}: {
  heading: string;
  basis: string;
  children: ReactNode;
}) {
  return (
    <div className={`${panel} flex flex-col gap-1 p-4`}>
      <span className={eyebrow}>{heading}</span>
      <div className="text-lg font-semibold text-foreground">{children}</div>
      {/* Every money figure on this page carries its basis: where the number
          came from, in the same block as the number. */}
      <p className="text-xs text-muted-foreground">{basis}</p>
    </div>
  );
}

function Tiles({ mandate }: { mandate: MandateRow }) {
  const t = useTranslations("mandate.tiles");
  return (
    <section
      aria-label={t("label")}
      data-testid="mandate-tiles"
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <Tile heading={t("perCall")} basis={t("perCallBasis")}>
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(measure) => measure.perCall}
        />
      </Tile>
      <Tile heading={t("perPeriod")} basis={t("perPeriodBasis")}>
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(measure) => measure.perPeriod}
          window
        />
      </Tile>
      <Tile heading={t("settled")} basis={t("settledBasis")}>
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(measure) => measure.settled}
        />
      </Tile>
      <Tile heading={t("remaining")} basis={t("remainingBasis")}>
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(measure) => measure.remaining}
        />
      </Tile>
    </section>
  );
}

function Header({
  mandate,
  at,
  readAt,
}: {
  mandate: MandateRow;
  at: MandateAt;
  readAt: Date;
}) {
  const t = useTranslations("mandate");
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className={eyebrow}>{t("eyebrow")}</p>
        <h1
          className={`${mono} min-w-0 break-all text-xl font-semibold text-foreground`}
        >
          {mandate.id}
        </h1>
        <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
          <MandateStatusBadge status={mandate.status} />
          {mandate.grantedBy === null ? (
            <span className="text-muted-foreground">{t("notGranted")}</span>
          ) : (
            <span className="text-muted-foreground">
              {t("grantedBy", { user: mandate.grantedBy })}
            </span>
          )}
          <SafeLink
            // The agent comes from the record, which is the only place that
            // knows it: the route names the mandate alone.
            to={routes.agent(at.org, at.ws, mandate.agentSlug, {
              tab: "mandates",
            })}
            className={linkText}
          >
            {mandate.agentSlug}
          </SafeLink>
        </div>
        <p className="max-w-prose pt-1 text-sm text-muted-foreground">
          {mandate.purpose}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <MandateActions
          org={at.org}
          ws={at.ws}
          mandate={mandate}
          here={mandateLink(at)}
          now={readAt}
        />
      </div>
    </header>
  );
}

/**
 * The reconciliation panel: whether every draw on this mandate carries a
 * receipt, and what to do about one that does not.
 *
 * It cannot answer that question yet and says so. A receipt frame is written by
 * the collector on each host, and no read the app may make carries one, so the
 * exception this panel exists to raise — a charge a connection's webhook
 * reported that no receipt accounts for — is not detectable here. The panel
 * states the rule, states that nothing can check it, and links to the one place
 * that does hold the governed actions on this mandate. Claiming "nothing is
 * outstanding" from a store that records no receipts would be the fabrication
 * this page is most dangerous for.
 */
function Reconciliation({ at }: { at: MandateAt }) {
  const t = useTranslations("mandate.reconciliation");
  return (
    <section
      aria-labelledby="mandate-reconciliation"
      data-testid="mandate-reconciliation"
      className={`${panel} flex flex-col gap-2 p-4`}
    >
      <h2 id="mandate-reconciliation" className="text-base font-semibold">
        {t("title")}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">{t("body")}</p>
      <p
        data-state="not-recorded"
        className="max-w-prose text-sm text-foreground"
      >
        {t("notRecorded")}
      </p>
      <SafeLink to={routes.audit(at.org)} className={linkText}>
        {t("openAudit")}
      </SafeLink>
    </section>
  );
}

/**
 * The skeleton: four tile blocks and a panel of seven rows, as the design shows.
 *
 * `role="status"` is what carries the name. A skeleton has to say what is
 * loading, and `aria-label` is prohibited on a plain `<div>`, which has no role
 * and so nothing to name — axe fails it under `aria-prohibited-attr` and a
 * screen reader announces nothing. `status` is the live region a reader already
 * expects beside `aria-busy`, it permits a name, and it keeps the skeleton
 * textless: the page must never flash a zero where a limit goes.
 */
export function MandateLoading() {
  const t = useTranslations("mandate");
  return (
    <div
      role="status"
      data-state="loading"
      aria-busy="true"
      aria-label={t("loading")}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className={`${panel} flex flex-col gap-2 p-4`}>
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-6 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-3 w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>
      <div className={`${panel} mt-4 flex flex-col gap-3 p-4`}>
        {[0, 1, 2, 3, 4, 5, 6].map((row) => (
          <div
            key={row}
            className="h-8 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
          />
        ))}
      </div>
    </div>
  );
}

function Loaded({
  detail,
  at,
  view,
  readAt,
}: {
  detail: MandateDetail;
  at: MandateAt;
  view: MandateView;
  readAt: Date;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Header mandate={detail.mandate} at={at} readAt={readAt} />
      <Tiles mandate={detail.mandate} />
      <MandateLedger detail={detail} at={at} view={view} />
      <div className="grid gap-4 lg:grid-cols-2">
        <MandateGrant mandate={detail.mandate} />
        <Reconciliation at={at} />
      </div>
    </div>
  );
}

/**
 * When the read came back, which the page prints as the "as of" instant beside
 * the tiles so a figure is never presented as newer than the answer it came
 * from — and which `Header` also hands to `MandateActions` as `now`, so the
 * validity-window check that decides whether `ChangeLimits` renders reads the
 * same server-resolved instant rather than a client clock hydration could
 * disagree with (`MandateActions`' own doc comment has the failure mode).
 *
 * It sits outside the component on purpose. `Mandate` is an async server
 * component, so reading the clock in its body runs once per request and is not
 * the impurity the React purity rule is built to catch, but the rule is
 * syntactic and this repo lints at zero warnings. Naming the call is better
 * than silencing the rule: the next reader learns what the instant means.
 */
function instantAfterRead(): Date {
  return new Date();
}

export async function Mandate({
  ctx,
  source,
  mandate,
  searchParams,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The mandate's public id, as the URL names it. */
  mandate: string;
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  // A URL that could never name a mandate is a 404 and not a page error: the
  // kernel would answer `invalid_input`, which renders as "this mandate could
  // not be loaded" and tells a reader the store is down when the address is
  // simply wrong.
  if (!MANDATE_ID.test(mandate)) notFound();
  const at: MandateAt = { org: ctx.orgSlug, ws: ctx.wsSlug, mandate };
  const view = parseMandateView(searchParams);
  const read = await source.mandates.get(ctx, mandate);
  const readAt = instantAfterRead();
  if (!read.ok) {
    // A mandate this workspace has not recorded is a 404, the same answer any
    // other address that names nothing gets.
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <Failure
        read={read}
        orgRole={ctx.orgRole}
        at={at}
        readAt={readAt.toISOString()}
      />
    );
  }
  return <Loaded detail={read.value} at={at} view={view} readAt={readAt} />;
}

/**
 * The failure states, with the instant the read was attempted formatted here
 * rather than inside the panel: a component may not ask a clock during render,
 * and the instant that matters is the one the read failed at.
 */
function Failure({
  read,
  orgRole,
  at,
  readAt,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
  orgRole: OrgRole;
  at: MandateAt;
  readAt: string;
}) {
  const format = useFormatter();
  return (
    <MandateReadFailure
      read={read}
      orgRole={orgRole}
      org={at.org}
      ws={at.ws}
      retry={mandateLink(at)}
      readAt={format.dateTime(new Date(readAt), {
        dateStyle: "medium",
        timeStyle: "long",
      })}
    />
  );
}
