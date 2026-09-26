// Tools › the mandates ledger (#2957; mockup `pTools` mandates tab): the
// mandates this workspace has recorded — granted, requested, expired and
// revoked — with what each has settled, what calls in flight hold and what is
// left, the page the accountable office reads. Each figure is the ledger's
// (INV-10); nothing here is a rollup of the rows beneath it.
//
// This header used to open on "every mandate the workspace has granted". Both
// halves of that were wrong and the paragraph below already said so: the read
// is narrowed for an unaccountable reader and bounded for everyone, and the
// ledger carries drafts, expiries and revocations, none of which is a grant.
// The lead on screen dropped the claim on 2026-09-16 and the comment kept it,
// so the file described a section it no longer renders.
//
// A reader without an accountable org role is not denied this read: the
// handler narrows it to the agents that reader created and answers an ordinary
// successful list. That makes the answer partial whatever its length — an
// empty one does not establish that the workspace has granted nothing, and a
// list of fifty rows is not every mandate either, though the lead above it
// would read as a claim that it is. `blindSpotOf` answers "is this the whole
// set", and one line above the rows says what is missing, so neither the empty
// state nor the table asserts more than the read can support.
//
// Grant a mandate sits in the ledger's header, and a requested row carries its
// own Grant, which opens the same dialog on that draft (`grant-mandate.tsx`).
// Both are drawn only for a reader whose org role some consequence can name
// (`canGrantMandates` in tools.tsx). A draft whose agent the agents read names
// retired is offered no Grant: retirement suspends the principal, so authority
// granted to it could never be drawn. The read leaves retired agents out by
// default (#4332), `retire_agent` revokes their drafts, and `grant_mandate`
// refuses one with `agent_retired`, so the server holds the line either way.
//
// A row's mandate id is the link to that mandate's own page (#2957): its
// authority, its ledger and its two governed writes. It was plain text here
// while the Agents tab one lane over already linked the same id, which left
// the office reading this ledger a table it could not open a row of.
//
// The registry, connections, kill switches and auto-approval rules are the
// other tabs of this page, drawn by their own files; the tab bar is
// `tabs.tsx`.
import { useTranslations } from "next-intl";
import type { OrgRole } from "@/data/contracts/common";
import {
  blindSpotOf,
  type MandateList,
  type MandateRow,
} from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { MandateAuthorityList } from "@/ui/mandate-authority";
import { MandateScope } from "@/ui/mandate-scope";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { useFormatter } from "@/ui/formatter";
import { type AgentChoices, GrantMandate } from "./grant-mandate";
import type { ToolsAt } from "./view";

/** What a reader who may grant is offered: the picker, and the agents it must not bind to. */
export type LedgerGrant = {
  agents: AgentChoices;
  /** Public ids of retired agents the agents read returned. */
  retired: ReadonlySet<string>;
};

function Row({
  mandate,
  at,
  grant,
}: {
  mandate: MandateRow;
  at: ToolsAt;
  grant: LedgerGrant | null;
}) {
  const t = useTranslations("tools.mandates");
  const format = useFormatter();
  return (
    <tr
      data-testid="mandate"
      data-status={mandate.status}
      className="border-t border-border align-top"
    >
      <td className="px-3 py-2">
        <SafeLink
          to={routes.mandate(at.org, at.ws, mandate.id)}
          className={`${mono} ${linkText} break-all`}
        >
          {mandate.id}
        </SafeLink>
        <div className="text-xs text-muted-foreground">
          {mandate.consequenceTags.join(", ")}
        </div>
      </td>
      <td className="px-3 py-2">
        <span className={mono}>{mandate.agentSlug}</span>
      </td>
      <td className="px-3 py-2">
        {mandate.grantedBy === null ? (
          // Nobody granted it, so the accountable name in this cell is the
          // operator who asked. `requestedBy` was on the view model and no
          // surface rendered it, so a ledger of drafts said only "not granted"
          // — an accountability record that could not say who sought the
          // authority. Null only when the row records no requester, which a
          // direct grant does not have.
          <>
            <span className="text-muted-foreground">{t("notGranted")}</span>
            {mandate.requestedBy === null ? null : (
              <div
                data-requested-by={mandate.requestedBy}
                className="text-xs text-muted-foreground"
              >
                {t("requestedBy", { user: mandate.requestedBy })}
              </div>
            )}
          </>
        ) : (
          <>
            <span className={`${mono} break-all`}>{mandate.grantedBy}</span>
            {mandate.roleAtGrant === null ? null : (
              <div className="text-xs text-muted-foreground">
                {mandate.roleAtGrant}
              </div>
            )}
          </>
        )}
      </td>
      <td className="max-w-xs px-3 py-2">{mandate.purpose}</td>
      <td className="px-3 py-2">
        <MandateScope tools={mandate.tools} />
      </td>
      <td className="px-3 py-2 text-right">
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(m) => m.perCall}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(m) => m.perPeriod}
          window
        />
      </td>
      <td className="px-3 py-2 text-right">
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(m) => m.settled}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(m) => m.reserved}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <MandateAuthorityList
          authority={mandate.authority}
          pick={(m) => m.remaining}
        />
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {format.dateTime(new Date(mandate.validTo), { dateStyle: "medium" })}
      </td>
      <td className="px-3 py-2">
        {t(`status.${mandate.status}`)}
        {grant === null ||
        mandate.status !== "draft" ||
        grant.retired.has(mandate.agentId) ? null : (
          <div className="mt-1">
            <GrantMandate at={at} agents={grant.agents} request={mandate} />
          </div>
        )}
      </td>
    </tr>
  );
}

const COLUMNS = [
  "mandate",
  "agent",
  "grantedBy",
  "purpose",
  "tools",
  "perCall",
  "perPeriod",
  "settled",
  "reserved",
  "remaining",
  "validTo",
  "status",
] as const;

export function MandatesLedger({
  read,
  orgRole,
  at,
  grant,
}: {
  read: Read<MandateList>;
  orgRole: OrgRole;
  at: ToolsAt;
  /** Null for a reader no consequence role can name, who is offered no grant. */
  grant: LedgerGrant | null;
}) {
  const t = useTranslations("tools.mandates");
  const title = t("title");
  /** Why an empty answer would not establish an empty ledger, or null when it would. */
  const blindSpot = read.ok ? blindSpotOf(read.value, orgRole) : null;
  return (
    <section aria-labelledby="tools-mandates" className={`${panel} p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="tools-mandates" className="text-base font-semibold">
            {title}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t("lead")}
          </p>
        </div>
        {grant === null ? null : <GrantMandate at={at} agents={grant.agents} />}
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
            {read.value.mandates.length > 0 ? null : (
              <div className="flex flex-col gap-1 text-sm">
                <p data-state="empty" data-blind-spot={blindSpot ?? undefined}>
                  {blindSpot === null ? t("empty") : t("emptyListed")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {blindSpot === null
                    ? t("emptyDetail")
                    : t("emptyListedDetail")}
                </p>
              </div>
            )}
            {read.value.mandates.length === 0 ? null : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-3xl text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      {COLUMNS.map((column) => (
                        <th
                          key={column}
                          scope="col"
                          className={`px-3 pb-2 font-medium ${
                            column === "perCall" ||
                            column === "perPeriod" ||
                            column === "settled" ||
                            column === "reserved" ||
                            column === "remaining"
                              ? "text-right"
                              : ""
                          }`}
                        >
                          {t(`columns.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {read.value.mandates.map((mandate) => (
                      <Row
                        key={mandate.id}
                        mandate={mandate}
                        at={at}
                        grant={grant}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
