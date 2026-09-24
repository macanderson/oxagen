// The approvals panel: one card per pending approval, soonest expiry first as
// list_approvals orders them, each card carrying the decision that answers it.
//
// A card draws the four-hop chain (MC spec §7.5): who asked, which agent,
// which action, which rule. Every hop is either a value the store recorded or
// the words "not recorded"; a blank hop would read as "no agent was involved"
// rather than "the gateway does not record one yet". The rule hop names the
// mandate the call drew on when there is one, because a rule id of the form
// `mandate:<id>:human_above:<measure>` is only legible next to the mandate.
//
// Under the chain sits what the workspace's auto-approval clause said about
// this call when it was parked (ADR-070), and under that the decision: approve
// or deny, with the reason the record keeps.
//
// A card whose call drew on a mandate carries the mandate bar (#2957): what
// the period has settled, what calls in flight reserve, and what is left, from
// the same ledger the Tools ledger reads. A card that drew on no mandate names
// none. A card whose mandate the page could not read — the viewer may not read
// the ledger, or the mandate fell outside the one page `list_mandates` answers
// — names the mandate instead of drawing nothing, because a bar that silently
// disappears reads as an agent acting under no authority at all.
//
// The bar reads the mandate's current period, which is what `list_mandates`
// answers, and a parked call can outlive one: an approval holds for up to 24
// hours, so a call parked before midnight holds a daily reservation recorded
// under the period that has since rolled. Neither the reservation nor its
// period key is on `list_approvals`, so the card says what the figures are
// counted over rather than implying they isolate this call.
import { useLocale, useTranslations } from "next-intl";
import type { ApprovalItem, ApprovalQueue } from "@/data/contracts/approvals";
import type { MandateRow } from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel, panelHeader } from "@/ui/control-styles";
import { drawsBar, MandateBar } from "@/ui/mandate-bar";
import { NamedMeasure } from "@/ui/measure";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { ApprovalDecision, Eligibility } from "./approval-decision";
import { Clock } from "./clock";

type Place = { org: string; ws: string };

function ApprovalCard({
  item,
  onResolved,
  mandate,
  now,
  org,
  ws,
  on,
}: {
  item: ApprovalItem;
  onResolved?: () => void;
  /** The mandate the call drew on, when the viewer could read it. */
  mandate: MandateRow | null;
  now: number;
  on: "fleet" | "run";
} & Place) {
  const t = useTranslations("fleet.approvals");
  /**
   * A mandate's measures are a partition, not an either/or: `drawsBar` (the
   * component's own predicate, so the two cannot drift) says which get a bar,
   * and the rest are limited per call with no period to count against. Both
   * halves are rendered. Keying on "are there any bars" instead hid the
   * per-call measures of a mandate that had one of each.
   */
  const authority = mandate?.authority ?? [];
  const metered = authority.filter(drawsBar);
  const perCallOnly = authority.filter(
    (a) => !drawsBar(a) && a.perCall !== null,
  );
  const recorded = (value: string | null) =>
    value === null ? (
      <dd className="text-muted-foreground">{t("notRecorded")}</dd>
    ) : (
      <dd className={`${mono} break-all`}>{value}</dd>
    );
  return (
    <li
      data-testid="approval"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
    >
      <p className={`${mono} break-all font-semibold`}>{item.tool}</p>
      <dl
        data-testid="chain"
        aria-label={t("chain.title")}
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
      >
        <dt className="text-muted-foreground">{t("chain.who")}</dt>
        {recorded(item.requester)}
        <dt className="text-muted-foreground">{t("chain.agent")}</dt>
        {recorded(item.agentKey)}
        <dt className="text-muted-foreground">{t("chain.action")}</dt>
        <dd className={`${mono} break-all`}>{item.tool}</dd>
        <dt className="text-muted-foreground">{t("chain.rule")}</dt>
        {item.rule === null ? (
          recorded(null)
        ) : (
          <dd className={`${mono} break-all`}>
            {item.rule}
            {item.mandateId === null
              ? null
              : ` (${t("chain.underMandate", { mandate: item.mandateId })})`}
          </dd>
        )}
      </dl>
      <Eligibility eligibility={item.autoEligibility} />
      {mandate !== null ? (
        <>
          {metered.map((measure) => (
            <MandateBar key={measure.measure} authority={measure} />
          ))}
          {metered.length === 0 ? null : (
            <p
              data-testid="mandate-period-basis"
              className="text-xs text-muted-foreground"
            >
              {t("mandatePeriodBasis")}
            </p>
          )}
          {perCallOnly.length === 0 ? null : (
            <p data-testid="mandate-per-call-only" className="text-xs">
              {t("mandatePerCallOnly", { mandate: mandate.id })}
              {perCallOnly.map((measure) =>
                measure.perCall === null ? null : (
                  <span key={measure.measure} className="ml-1">
                    <NamedMeasure
                      measure={measure.measure}
                      value={measure.perCall}
                    />
                  </span>
                ),
              )}
            </p>
          )}
        </>
      ) : item.mandateId === null ? null : (
        <p data-testid="mandate-unread" className="text-xs">
          {t("mandateUnread", { mandate: item.mandateId })}
        </p>
      )}
      <p className="text-xs">
        {t.rich("timesOut", {
          clock: () => (
            <Clock
              at={Date.parse(item.expiresAt)}
              now={now}
              direction="until"
            />
          ),
        })}
      </p>
      {item.runId === null ? null : (
        <SafeLink
          to={routes.run(org, ws, item.runId)}
          className={`${linkText} self-start text-xs`}
        >
          {t("openRun")}
        </SafeLink>
      )}
      <ApprovalDecision
        onResolved={onResolved}
        approvalId={item.id}
        tool={item.tool}
        eligibility={item.autoEligibility}
        org={org}
        ws={ws}
        on={on}
      />
    </li>
  );
}

export function ApprovalsPanel({
  approvals,
  mandates,
  now,
  org,
  ws,
  on = "fleet",
  onResolved,
}: {
  approvals: Read<ApprovalQueue>;
  /** The mandates the cards name, by public id; empty when none was read. */
  mandates: ReadonlyMap<string, MandateRow>;
  now: number;
  /**
   * Which page is drawing the panel. It names the heading's element, so the
   * Run page's copy cannot collide with Fleet's id, and it is the page key a
   * refused eligibility re-read reports its permission under. Nothing a reader
   * acts on changes with it: an approval must read the same on both pages.
   */
  on?: "fleet" | "run";
  onResolved?: () => void;
} & Place) {
  const t = useTranslations("fleet.approvals");
  const locale = useLocale();
  const headingId = `${on}-approvals`;
  return (
    <section aria-labelledby={headingId} className={`${panel} p-4`}>
      <div className={`${panelHeader} -mx-4 -mt-4 mb-3`}>
        <h2 id={headingId} className="text-sm font-semibold">
          {t("title")}
        </h2>
        {approvals.ok ? (
          <span className="text-xs text-muted-foreground">
            {/*
              The figure the header and the waiting tile both stand behind: the
              count the read took, marked `+` when the read stopped before the
              end of the queue. Writing the bare length here read as the whole
              queue, which is the figure an operator staffs against. The `more`
              call sits in the component rather than in a helper the translator
              is passed to, because INV-12 follows a translator to its calls
              and a key it cannot see is a key it reports as unused.
            */}
            {t("parked", {
              count: approvals.value.more
                ? t("more", {
                    count: formatCount(approvals.value.items.length, locale),
                  })
                : formatCount(approvals.value.items.length, locale),
            })}
          </span>
        ) : null}
      </div>
      {!approvals.ok ? (
        <ReadFailure read={approvals} section={t("title")} />
      ) : approvals.value.items.length === 0 ? (
        <div className="flex flex-col gap-1 text-sm">
          <p>{t("empty")}</p>
          <p className="text-xs text-muted-foreground">{t("emptyDetail")}</p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {approvals.value.items.map((item) => (
            <ApprovalCard
              onResolved={onResolved}
              key={item.id}
              item={item}
              mandate={
                item.mandateId === null
                  ? null
                  : (mandates.get(item.mandateId) ?? null)
              }
              now={now}
              org={org}
              ws={ws}
              on={on}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
