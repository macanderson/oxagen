// Agents › Mandates (#2957; mockup `aMandates`): the mandates this agent
// holds, and — when it holds none — what that means for a call that carries a
// consequence. Nothing in a role, a grant or a toolbelt substitutes for a
// mandate: a call carrying a consequence tag with no mandate is denied before
// dispatch, before any credential is minted.
//
// The section reads `list_mandates` narrowed to the agent. A member without an
// accountable org role is not denied on that read: the handler narrows it to
// the agents that reader created and answers a successful, shorter list. So an
// empty answer means one of two things — the agent holds no mandate, or it
// holds mandates this reader may not see — and only an accountable reader can
// tell them apart. The "No mandate" state says a call carrying a consequence
// is denied before dispatch, which is a statement about the agent's authority
// and not about this list, so it is shown only to a reader whose answer covers
// every mandate. A truncated page is the second reason, and it bites the other
// way round: a hundred newer drafts can push the one mandate still in effect
// off a newest-first read, so rows are present and none of them authorize
// anything. `blindSpotOf` answers both from the evidence that still holds them
// — the reader's role and `truncatedAt` — because neither is visible in the
// rows. `blindSpotOf` asks "is this the whole set", not "is it empty", because
// incompleteness is a property of the answer and not of its length: a narrowed
// list of fifty rows is as partial as a narrowed list of none. So one line
// states what the answer is missing whenever anything is, above the rows and
// above the authority statement both, and every claim below it is read against
// it — the empty state declines to assert absence, and the table no longer
// implies it is everything the agent holds.
//
// A retired identity is not offered the request. Retirement archives the agent
// and suspends its principal, so a mandate granted after it can never be drawn
// — and neither `request_mandate` nor `grant_mandate` resolves that status
// (`resolveAgent` filters on `deletedAt`, which retirement does not set), so
// the write would succeed and put real authority in the ledger against an
// identity that can never run. The page declines to offer it and says why;
// closing it on the other surfaces is the handler's, and is filed as #3124.
//
// What a row must show is not this page's question to answer on its own. A
// mandate's scope and its per-measure accounting window are facts of the view
// model, and the Tools ledger had already dropped both and been corrected; this
// table dropped the same two independently. Two components re-projecting one
// view model and losing the same fields is a missing shared presentation, not
// two local bugs, so both now render through `MandateScope` and
// `MandateAuthorityList` in `@/ui` and the next table to show a mandate gets
// them without asking.
//
// A third fact is this page's own. An `active` mandate whose `validFrom` is
// still ahead is granted and not yet usable — `isEffective` excludes it, the
// status column calls it active, and the empty state offered only "a request
// awaiting a decision, or history". Both readings were on screen at once. The
// row now says when it starts and the empty state has a sentence for the state
// it is in.
//
// The warning is driven by authority and not by row count. A draft, a revoked
// row and an expired one all authorize nothing, and `request_mandate` writes a
// draft — so a page that asked "are there rows?" would stop warning the moment
// an operator requested a mandate, which is the moment the agent still has
// none. The rows stay in the table, because the request and the history are
// what the office reads; only the claim about authority is theirs to make.
import { useTranslations } from "next-intl";
import type { AgentStatus } from "@/data/contracts/agents";
import type { OrgRole } from "@/data/contracts/common";
import {
  blindSpotOf,
  isEffective,
  isUpcoming,
  type MandateList,
} from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { MandateAuthorityList } from "@/ui/mandate-authority";
import { MandateScope } from "@/ui/mandate-scope";
import { Badge } from "@/ui/badge";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { RequestMandate } from "./mandate-request";
import { useFormatter } from "@/ui/formatter";

type Place = {
  org: string;
  ws: string;
  agentId: string;
  agentSlug: string;
  /** Named in the denial chain's mandate lookup; null when the store records none. */
  agentKey: string | null;
};

/**
 * The four steps a financial call from an agent with no mandate takes (spec
 * pages/agent.md, "No mandate"): the call, its financial class, the lookup
 * that finds nothing, and the decision. It describes the pipeline, so it
 * names no amount and no tool the record does not hold.
 */
function DenialChain({ agentKey }: { agentKey: string | null }) {
  const t = useTranslations("agents.mandates.chain");
  const steps = [
    { key: "call", body: t("callValue") },
    { key: "financial", body: t("financialValue") },
    {
      key: "lookup",
      body: t("lookupValue", { agent: agentKey ?? t("thisAgent") }),
    },
    { key: "decision", body: t("decisionValue") },
  ] as const;
  return (
    <ol
      aria-label={t("label")}
      data-testid="denial-chain"
      className="flex flex-col gap-2"
    >
      {steps.map((step, index) => (
        <li
          key={step.key}
          className="flex gap-3 rounded-lg border border-border bg-hl px-3 py-2"
        >
          <span
            aria-hidden="true"
            className="grid size-5 shrink-0 place-items-center rounded-full border border-border text-[11px] text-dim"
          >
            {index + 1}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-dim">
              {t(step.key)}
            </span>
            <span className="text-[13px]">
              {step.key === "decision" ? (
                <>
                  <Badge tone="denied">{t("denied")}</Badge>{" "}
                  <span className={mono}>no_mandate</span> {step.body}
                </>
              ) : (
                step.body
              )}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

const COLUMNS = [
  "mandate",
  "effect",
  "tools",
  "perCall",
  "perPeriod",
  "remaining",
  "validTo",
  "status",
] as const;

export function MandatesSection({
  read,
  orgRole,
  agentStatus,
  ...place
}: {
  read: Read<MandateList>;
  orgRole: OrgRole;
  /** A retired identity can hold no new authority: the request is not offered. */
  agentStatus: AgentStatus;
} & Place) {
  const t = useTranslations("agents.mandates");
  const format = useFormatter();
  const title = t("title");
  const held = read.ok ? read.value.mandates : [];
  /** Of those rows, the ones that authorize a call right now — none of the rest do. */
  const asOf = read.ok ? new Date(read.value.asOf) : null;
  const effective =
    asOf === null ? [] : held.filter((mandate) => isEffective(mandate, asOf));
  /**
   * Of the rest, the ones that are granted and have simply not started. They
   * are neither a request awaiting a decision nor history, which is everything
   * the empty state used to offer, and the table labels them active — so
   * without this the page gave the accountable reader two contradictory
   * accounts of why the agent's authority is not usable.
   */
  const upcoming =
    asOf === null ? [] : held.filter((mandate) => isUpcoming(mandate, asOf));
  /**
   * Why an empty `effective` would not establish that the agent holds nothing,
   * or null when it would. A narrowed reader and a truncated page are both
   * reasons, and neither is visible in the rows themselves.
   */
  const blindSpot = read.ok ? blindSpotOf(read.value, orgRole) : null;
  /** Retirement suspends the principal, so authority granted after it can never be drawn. */
  const retired = agentStatus === "retired";
  return (
    <section aria-labelledby="agent-mandates" className={`${panel} p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="agent-mandates" className="text-base font-semibold">
            {read.ok && effective.length === 0
              ? blindSpot === null
                ? t("noneTitle")
                : t("noneListedTitle")
              : title}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t("lead")}
          </p>
        </div>
        {read.ok && blindSpot === null ? (
          effective.length === 0 ? (
            <Badge tone="proven" data-testid="mandate-badge">
              {t("cannotMove")}
            </Badge>
          ) : (
            <Badge tone="approval" data-testid="mandate-badge">
              {t("active", { count: effective.length })}
            </Badge>
          )
        ) : null}
        {retired ? (
          <p
            data-state="retired"
            className="max-w-xs text-sm text-muted-foreground"
          >
            {t("retired")}
          </p>
        ) : (
          <RequestMandate
            org={place.org}
            ws={place.ws}
            agentId={place.agentId}
            agentSlug={place.agentSlug}
          />
        )}
      </div>
      <div className="mt-3">
        {!read.ok ? (
          <ReadFailure read={read} section={title} />
        ) : (
          <div className="flex flex-col gap-3">
            {blindSpot === null ? null : (
              <p
                data-state="incomplete"
                data-blind-spot={blindSpot}
                className="max-w-prose text-sm text-foreground"
              >
                {blindSpot === "truncated"
                  ? t("truncated", { shown: String(read.value.truncatedAt) })
                  : t("partial")}
              </p>
            )}
            {effective.length > 0 ? null : (
              <div className="flex flex-col gap-2 text-sm">
                <p data-state="empty" data-blind-spot={blindSpot ?? undefined}>
                  {blindSpot !== null
                    ? t("noneListed")
                    : held.length === 0
                      ? t("none")
                      : upcoming.length > 0
                        ? t("noneEffectiveUpcoming")
                        : t("noneEffective")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {blindSpot === null ? t("noneDetail") : t("noneListedDetail")}
                </p>
                {blindSpot === null ? (
                  <DenialChain agentKey={place.agentKey} />
                ) : null}
              </div>
            )}
            {held.length === 0 ? null : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        {COLUMNS.map((column) => (
                          <th
                            key={column}
                            scope="col"
                            className="px-3 pb-2 font-medium"
                          >
                            {t(`columns.${column}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {held.map((mandate) => {
                        /** Granted, and not yet started: the row says so beside the status. */
                        const starts =
                          asOf !== null && isUpcoming(mandate, asOf);
                        return (
                          <tr
                            key={mandate.id}
                            data-testid="agent-mandate"
                            data-status={mandate.status}
                            data-effect={starts ? "upcoming" : undefined}
                            className="border-t border-border align-top"
                          >
                            <td className="px-3 py-2">
                              {/* The id is the link to the mandate's own page
                                  (#2957): its ledger, its grant and its two
                                  governed writes. It was plain text here while
                                  that page did not exist, which left the
                                  accountable office a table it could not open a
                                  row of. */}
                              <SafeLink
                                to={routes.mandate(
                                  place.org,
                                  place.ws,
                                  mandate.id,
                                )}
                                className={`${mono} ${linkText} break-all`}
                              >
                                {mandate.id}
                              </SafeLink>
                            </td>
                            <td className="px-3 py-2">
                              {mandate.consequenceTags.join(", ")}
                            </td>
                            <td className="px-3 py-2">
                              <MandateScope tools={mandate.tools} />
                            </td>
                            <td className="px-3 py-2">
                              <MandateAuthorityList
                                authority={mandate.authority}
                                pick={(measure) => measure.perCall}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <MandateAuthorityList
                                authority={mandate.authority}
                                pick={(measure) => measure.perPeriod}
                                window
                              />
                            </td>
                            <td className="px-3 py-2">
                              <MandateAuthorityList
                                authority={mandate.authority}
                                pick={(measure) => measure.remaining}
                              />
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              {format.dateTime(new Date(mandate.validTo), {
                                dateStyle: "medium",
                              })}
                            </td>
                            <td className="px-3 py-2">
                              {t(`status.${mandate.status}`)}
                              {starts ? (
                                <div
                                  data-state="upcoming"
                                  className="whitespace-nowrap text-xs text-muted-foreground"
                                >
                                  {t("startsOn", {
                                    date: format.dateTime(
                                      new Date(mandate.validFrom),
                                      { dateStyle: "medium" },
                                    ),
                                  })}
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <p className="mt-3 max-w-prose text-xs text-muted-foreground">
        {t("authority")}
      </p>
    </section>
  );
}
