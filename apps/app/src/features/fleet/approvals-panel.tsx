// The approval card: one pending approval with the decision that answers it,
// drawn by the shell's approvals drawer through `ApprovalCardAlone`.
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
import { useTranslations } from "next-intl";
import type { ApprovalItem } from "@/data/contracts/approvals";
import type { MandateRow } from "@/data/contracts/mandates";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { drawsBar, MandateBar } from "@/ui/mandate-bar";
import { NamedMeasure } from "@/ui/measure";
import { SafeLink } from "@/ui/navigation";
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

/**
 * One approval card with no panel around it: the approvals drawer's selected
 * card (mockup `apdBody()` draws `approvalCard(a)` alone under "‹ All
 * approvals"). No heading, no parked count and no two-column grid, so the
 * drawer carries one "Approvals" heading and the card takes the drawer's full
 * width. The card and its decision are the same component Fleet and Run draw,
 * so Approve and Deny are the same governed write.
 */
export function ApprovalCardAlone({
  item,
  mandates,
  now,
  org,
  ws,
}: {
  item: ApprovalItem;
  /** The mandates the workspace's parked calls drew on, by public id. */
  mandates: ReadonlyMap<string, MandateRow>;
  now: number;
} & Place) {
  return (
    <ul data-testid="approval-card-alone" className="flex flex-col">
      <ApprovalCard
        item={item}
        mandate={
          item.mandateId === null
            ? null
            : (mandates.get(item.mandateId) ?? null)
        }
        now={now}
        org={org}
        ws={ws}
        on="fleet"
      />
    </ul>
  );
}
