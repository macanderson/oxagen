// Tools › the mandates ledger (#2957; mockup `pTools` mandates tab): every
// mandate the workspace has granted, with what each has settled, what calls
// in flight hold and what is left — the page the accountable office reads.
// Each figure is the ledger's (INV-10); nothing here is a rollup of the rows
// beneath it.
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
// The registry, connections, kill switches and auto-approval rules are the
// other tabs of this page and have no backing yet, so they are not drawn
// (§3.6) and the page has no tab bar until the #2958 lane gives it a second
// tab.
import { useFormatter, useTranslations } from "next-intl";
import type { OrgRole } from "@/data/contracts/common";
import {
  blindSpotOf,
  type MandateList,
  type MandateRow,
} from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import { mono, panel } from "@/ui/control-styles";
import { NamedMeasure } from "@/ui/measure";
import { ReadFailure } from "@/ui/read-failure";

function Authority({
  authority,
  pick,
  window: showWindow = false,
}: {
  authority: MandateRow["authority"];
  pick: (
    of: MandateRow["authority"][number],
  ) => MandateRow["authority"][number]["settled"] | null;
  /**
   * Names the accounting window this measure's limit and balance belong to.
   * A daily 100 and a monthly 100 are different authorities and rendered the
   * same without it, and settled/reserved/remaining mean nothing until the
   * reader knows which window they are counted over. Each measure carries its
   * own — a mandate may cap calls daily and money monthly — so the window sits
   * with the limit it belongs to rather than once per row.
   */
  window?: boolean;
}) {
  const t = useTranslations("tools.mandates");
  const values = authority
    .map((measure) => ({
      measure: measure.measure,
      period: measure.period,
      periodKey: measure.periodKey,
      value: pick(measure),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & { value: NonNullable<typeof entry.value> } =>
        entry.value !== null,
    );
  if (values.length === 0)
    return <span className="text-muted-foreground">{t("noLimit")}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {values.map((entry) => (
        <li key={entry.measure}>
          <NamedMeasure measure={entry.measure} value={entry.value} />
          {showWindow ? (
            <div className="text-xs text-muted-foreground">
              {t("window", {
                period: t(`period.${entry.period}`),
                periodKey: entry.periodKey,
              })}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Row({ mandate }: { mandate: MandateRow }) {
  const t = useTranslations("tools.mandates");
  const format = useFormatter();
  return (
    <tr
      data-testid="mandate"
      data-status={mandate.status}
      className="border-t border-border align-top"
    >
      <td className="px-3 py-2">
        <span className={`${mono} break-all`}>{mandate.id}</span>
        <div className="text-xs text-muted-foreground">
          {mandate.consequenceTags.join(", ")}
        </div>
      </td>
      <td className="px-3 py-2">
        <span className={mono}>{mandate.agentSlug}</span>
      </td>
      <td className="px-3 py-2">
        {mandate.grantedBy === null ? (
          <span className="text-muted-foreground">{t("notGranted")}</span>
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
        {mandate.tools.includes(EVERY_TOOL) ? (
          <span
            data-scope="every-tool"
            className="rounded bg-foreground px-1.5 py-0.5 text-xs font-medium text-background"
          >
            {t("everyTool")}
          </span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {mandate.tools.map((pattern) => (
              <li key={pattern} className={`${mono} break-all text-xs`}>
                {pattern}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <Authority authority={mandate.authority} pick={(m) => m.perCall} />
      </td>
      <td className="px-3 py-2 text-right">
        <Authority
          authority={mandate.authority}
          pick={(m) => m.perPeriod}
          window
        />
      </td>
      <td className="px-3 py-2 text-right">
        <Authority authority={mandate.authority} pick={(m) => m.settled} />
      </td>
      <td className="px-3 py-2 text-right">
        <Authority authority={mandate.authority} pick={(m) => m.reserved} />
      </td>
      <td className="px-3 py-2 text-right">
        <Authority authority={mandate.authority} pick={(m) => m.remaining} />
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {format.dateTime(new Date(mandate.validTo), { dateStyle: "medium" })}
      </td>
      <td className="px-3 py-2">{t(`status.${mandate.status}`)}</td>
    </tr>
  );
}

/**
 * The pattern that matches every tool at every version. A mandate scoped `*`
 * and one scoped `payments.read@*` are the difference between an agent that
 * may call everything and one that may call a single tool, and they rendered
 * as the same row on the page an accountable reader uses to review what they
 * granted. It is called out rather than printed, because a reader should not
 * have to notice one character.
 */
const EVERY_TOOL = "*";

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
}: {
  read: Read<MandateList>;
  orgRole: OrgRole;
}) {
  const t = useTranslations("tools.mandates");
  const title = t("title");
  /** Why an empty answer would not establish an empty ledger, or null when it would. */
  const blindSpot = read.ok ? blindSpotOf(read.value, orgRole) : null;
  return (
    <section aria-labelledby="tools-mandates" className={`${panel} p-4`}>
      <h2 id="tools-mandates" className="text-base font-semibold">
        {title}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {t("lead")}
      </p>
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
                      <Row key={mandate.id} mandate={mandate} />
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
