// One mandate (#2957; ADR-059; the design's `pMandate`): the delegated
// financial authority an agent holds, its limits, what has been settled and
// reserved against it, the grant that created it, and the ledger of every draw.
//
// The page reads `get_mandate` for the record, then, beside it, the agent the
// mandate was granted to (for the agent card) and the org's members (to name
// the granter). Every figure is the ledger's own accounting (INV-10):
// `authority` carries, per measure, the limits, what the period has settled,
// what calls in flight have reserved and what is left, so the tiles, the bar
// and the ledger read one record and nothing here sums the table.
//
// Layout, in the design's order: the header, four tiles, then a split with the
// Ledger panel on the left and the Grant and exception panels on the right. On
// a narrow screen the split stacks with the ledger first.
//
// **A not-loaded state replaces the body, never the shell.** The header goes
// with the body, because a header naming a mandate the reader may not see is
// itself a disclosure. The design's empty state replaces the body too, with no
// actions: a mandate in effect whose ledger holds no draw. A mandate that is
// not in effect keeps its header, because its empty ledger is not the design's
// "it is active" and a draft still needs its Decline.
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  isEffective,
  type MandateDetail,
  type MandateRow,
} from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx, WsRole } from "@/server/viewer";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  eyebrow,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { Measure, NamedMeasure } from "@/ui/measure";
import { type GrantAgent, MandateGrant, type PeopleNames } from "./grant";
import { MandateLedger } from "./ledger";
import { MandateActions } from "./mandate-actions";
import { MandateReadFailure } from "./read-failure";
import { NotBacked, StateWrap } from "./state";
import {
  type MandateAt,
  MANDATE_ID,
  mandateLink,
  measuresOf,
  traceTime,
  unitsOf,
} from "./view";

/** The design's badge per status. Gold is identity and never encodes state. */
const STATUS_TONE: Record<MandateRow["status"], BadgeTone> = {
  draft: "approval",
  active: "allowed",
  expired: "quiet",
  revoked: "denied",
};

function Tile({
  heading,
  basis,
  testId,
  children,
}: {
  heading: string;
  basis: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className={statTile}>
      <span className={statTerm}>{heading}</span>
      <div className={statValue}>{children}</div>
      {/* Every money figure on this page carries its basis, in the same block. */}
      <span className={statNote}>{basis}</span>
    </div>
  );
}

/** A figure or the words for its absence; another measure's figures ride under it, named. */
function Figure({
  value,
  none,
  others,
}: {
  value: MandateRow["authority"][number]["perCall"];
  none: string;
  others: readonly {
    measure: string;
    value: MandateRow["authority"][number]["perCall"];
  }[];
}) {
  return (
    <>
      {value === null ? (
        <span className="text-base font-medium text-muted-foreground">
          {none}
        </span>
      ) : (
        <Measure value={value} />
      )}
      {others.map((other) =>
        other.value === null ? null : (
          <span
            key={other.measure}
            className="block text-xs font-normal tracking-normal"
          >
            <NamedMeasure measure={other.measure} value={other.value} />
          </span>
        ),
      )}
    </>
  );
}

function Tiles({ mandate }: { mandate: MandateRow }) {
  const t = useTranslations("mandate.tiles");
  const { primary, calls, others } = measuresOf(mandate);
  if (primary === null) return null;
  const period = t(`periods.${primary.period}`);
  const cap = calls?.perPeriod ?? null;
  const pick = (
    of: (a: (typeof others)[number]) => (typeof others)[number]["perCall"],
  ) => others.map((a) => ({ measure: a.measure, value: of(a) }));
  return (
    <section
      aria-label={t("label")}
      data-testid="mandate-tiles"
      className={statStrip}
    >
      <Tile
        heading={t("perCall")}
        testId="tile-per-call"
        basis={
          primary.measure === "calls" ? t("perCallCalls") : t("perCallBasis")
        }
      >
        <Figure
          value={primary.perCall}
          none={t("noLimit")}
          others={pick((a) => a.perCall)}
        />
      </Tile>
      <Tile
        heading={t("perPeriod")}
        testId="tile-per-period"
        basis={
          calls !== null && cap !== null && cap.kind === "count"
            ? t("perPeriodCalls", {
                period,
                calls: cap.count,
                window: t(`windows.${calls.period}`),
              })
            : period
        }
      >
        <Figure
          value={primary.perPeriod}
          none={t("noLimit")}
          others={pick((a) => a.perPeriod)}
        />
      </Tile>
      <Tile
        heading={t("settled")}
        testId="tile-settled"
        basis={t("settledBasis")}
      >
        <Figure
          value={primary.settled}
          none={t("noLimit")}
          others={pick((a) => a.settled)}
        />
      </Tile>
      <Tile
        heading={t("remaining")}
        testId="tile-remaining"
        basis={t.rich("remainingBasis", {
          reserved: () => <Measure value={primary.reserved} />,
        })}
      >
        <span className="text-info">
          <Figure
            value={primary.remaining}
            none={t("noPeriodLimit")}
            others={pick((a) => a.remaining)}
          />
        </span>
      </Tile>
    </section>
  );
}

function Header({
  mandate,
  at,
  readAt,
  people,
  agentKey,
}: {
  mandate: MandateRow;
  at: MandateAt;
  readAt: Date;
  people: PeopleNames;
  agentKey: string | null;
}) {
  const t = useTranslations("mandate");
  const granter =
    mandate.grantedBy === null
      ? null
      : (people[mandate.grantedBy] ?? mandate.grantedBy);
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col">
        <p className={eyebrow}>{t("eyebrow")}</p>
        <h1
          className={`${mono} mt-1 min-w-0 break-all text-xl font-semibold text-foreground`}
        >
          {mandate.id}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge
            tone={STATUS_TONE[mandate.status]}
            data-status={mandate.status}
          >
            {t(`status.${mandate.status}`)}
          </Badge>
          <Badge tone="quiet" dot={false}>
            {granter === null
              ? t("notGranted")
              : t("grantedBy", { name: granter })}
          </Badge>
          {unitsOf(mandate).map((unit) => (
            <Badge key={unit} tone="quiet" dot={false}>
              {unit}
            </Badge>
          ))}
        </div>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          {mandate.purpose}
        </p>
      </div>
      <MandateActions
        org={at.org}
        ws={at.ws}
        mandate={mandate}
        here={mandateLink(at)}
        agentKey={agentKey}
        now={readAt}
      />
    </header>
  );
}

/**
 * The exception panel under the grant (the design titles it Ledger too): whether
 * every draw carries a receipt and every receipt a frame, and the charge a
 * connection reported with no receipt when one did not.
 *
 * It cannot answer yet and says so. Receipt frames are written by the collector
 * on each host, and no read the app may make carries one or a connection's
 * charge feed, so the exception this panel exists to raise is not detectable
 * here. Claiming "nothing is outstanding" from a store that records no receipts
 * would be the fabrication this page is most dangerous for.
 */
function Exceptions() {
  const t = useTranslations("mandate.exceptions");
  return (
    <section
      aria-labelledby="mandate-exceptions"
      data-testid="mandate-exceptions"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="mandate-exceptions" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <div className={panelBody}>
        <NotBacked gap="G8" block>
          {t("notBacked")}
        </NotBacked>
      </div>
    </section>
  );
}

/**
 * The skeleton: four tile blocks and a panel of seven rows, as the design
 * shows. `role="status"` carries the name, and the skeleton holds no text, so
 * the page never flashes a zero where a limit goes.
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
      <div className={`${statStrip} mb-4`}>
        {[0, 1, 2, 3].map((tile) => (
          <div
            key={tile}
            className={`${statTile} h-[88px] animate-pulse bg-hl motion-reduce:animate-none`}
          />
        ))}
      </div>
      <div className={panel}>
        <div className={panelHeader}>
          <div className="h-3.5 w-[180px] animate-pulse rounded bg-hl motion-reduce:animate-none" />
        </div>
        <div className={`${panelBody} flex flex-col gap-2`}>
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <div
              key={row}
              className="h-8 animate-pulse rounded-md bg-hl motion-reduce:animate-none"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Loaded({
  detail,
  at,
  readAt,
  agent,
  people,
}: {
  detail: MandateDetail;
  at: MandateAt;
  readAt: Date;
  agent: GrantAgent;
  people: PeopleNames;
}) {
  // The design's empty state: a mandate in effect that has never been drawn on
  // is the state alone, with no actions. `asOf` is the instant the ledger
  // answered, so the judgement is a pure read of the answer.
  if (
    detail.draws.length === 0 &&
    isEffective(detail.mandate, new Date(detail.asOf))
  )
    return <MandateNeverDrawn />;
  return (
    <div className="flex flex-col gap-4">
      <Header
        mandate={detail.mandate}
        at={at}
        readAt={readAt}
        people={people}
        agentKey={agent?.agentKey ?? null}
      />
      <Tiles mandate={detail.mandate} />
      <div className="grid items-start gap-3.5 min-[1080px]:grid-cols-[minmax(0,1fr)_340px]">
        <MandateLedger detail={detail} />
        <div className="flex min-w-0 flex-col gap-3.5">
          <MandateGrant
            mandate={detail.mandate}
            agent={agent}
            people={people}
            at={at}
          />
          <Exceptions />
        </div>
      </div>
    </div>
  );
}

/** The design's empty state, in place of the page body. */
export function MandateNeverDrawn() {
  const t = useTranslations("mandate.ledger");
  return (
    <StateWrap
      kind="empty"
      title={t("empty")}
      headingLevel={1}
      testId="mandate-empty"
    >
      {t("emptyBodyEffective")}
    </StateWrap>
  );
}

/**
 * When the read came back: `MandateActions` takes it as `now`, so the validity
 * check that decides whether Change limits renders reads one server-resolved
 * instant rather than a client clock hydration could disagree with.
 */
function instantAfterRead(): Date {
  return new Date();
}

/** The names of the people this mandate names, or none when the member list is not readable. */
async function peopleOf(
  source: DataSource,
  ctx: WsCtx,
  mandate: MandateRow,
): Promise<PeopleNames> {
  if (mandate.grantedBy === null && mandate.requestedBy === null) return {};
  const read = await source.org.members(ctx);
  if (!read.ok) return {};
  const names: Record<string, string> = {};
  for (const member of read.value.members)
    if (member.name !== null) names[member.id] = member.name;
  return names;
}

async function agentOf(
  source: DataSource,
  ctx: WsCtx,
  slug: string,
): Promise<GrantAgent> {
  const read = await source.agents.get(ctx, slug);
  return read.ok
    ? {
        agentKey: read.value.identity.agentKey,
        name: read.value.identity.name,
        harness: read.value.identity.harness,
      }
    : null;
}

export async function Mandate({
  ctx,
  source,
  mandate,
  agent = null,
  viewerName = null,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The signed-in person's name (or email), for the denied state's *Signed in as*. */
  viewerName?: string | null;
  /** The mandate's public id, as the URL names it. */
  mandate: string;
  /** The agent slug the nested route names; null on the flat route. */
  agent?: string | null;
}) {
  // A URL that could never name a mandate is a 404 and not a page error.
  if (!MANDATE_ID.test(mandate)) notFound();
  const at: MandateAt = { org: ctx.orgSlug, ws: ctx.wsSlug, mandate, agent };
  const read = await source.mandates.get(ctx, mandate);
  const readAt = instantAfterRead();
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    // Denied names the person it refused, as the design's *Signed in as*
    // does: the name the route read from this request's session, the
    // workspace role and the workspace.
    return (
      <Failure
        read={read}
        viewer={{ name: viewerName, wsRole: ctx.wsRole }}
        orgName={ctx.orgName}
        at={at}
        readAt={readAt.toISOString()}
      />
    );
  }
  // The nested route names the agent too, and a name the record contradicts is
  // an address that names nothing: the agent segment is checked, never trusted.
  if (agent !== null && read.value.mandate.agentSlug !== agent) notFound();
  const [people, grantAgent] = await Promise.all([
    peopleOf(source, ctx, read.value.mandate),
    agentOf(source, ctx, read.value.mandate.agentSlug),
  ]);
  return (
    <Loaded
      detail={read.value}
      at={at}
      readAt={readAt}
      agent={grantAgent}
      people={people}
    />
  );
}

function Failure({
  read,
  viewer,
  orgName,
  at,
  readAt,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
  viewer: { name: string | null; wsRole: WsRole };
  orgName: string;
  at: MandateAt;
  readAt: string;
}) {
  return (
    <MandateReadFailure
      read={read}
      viewer={viewer}
      orgName={orgName}
      org={at.org}
      ws={at.ws}
      retry={mandateLink(at)}
      mandate={at.mandate}
      readAt={traceTime(new Date(readAt))}
    />
  );
}
