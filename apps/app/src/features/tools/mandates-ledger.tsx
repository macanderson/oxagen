// Tools › the mandates ledger (#2957; mockup `pTools` mandates tab): every
// mandate the workspace has granted, with what each has settled, what calls
// in flight hold and what is left — the page the accountable office reads.
// Each figure is the ledger's (INV-10); nothing here is a rollup of the rows
// beneath it.
//
// The registry, connections, kill switches and auto-approval rules are the
// other tabs of this page and have no backing yet, so they are not drawn
// (§3.6) and the page has no tab bar until the #2958 lane gives it a second
// tab.
import { useFormatter, useTranslations } from "next-intl";
import type { MandateList, MandateRow } from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import { mono, panel } from "@/ui/control-styles";
import { Measure } from "@/ui/measure";
import { ReadFailure } from "@/ui/read-failure";

function Authority({
  authority,
  pick,
}: {
  authority: MandateRow["authority"];
  pick: (
    of: MandateRow["authority"][number],
  ) => MandateRow["authority"][number]["settled"] | null;
}) {
  const t = useTranslations("tools.mandates");
  const values = authority
    .map((measure) => ({ measure: measure.measure, value: pick(measure) }))
    .filter(
      (
        entry,
      ): entry is { measure: string; value: NonNullable<typeof entry.value> } =>
        entry.value !== null,
    );
  if (values.length === 0)
    return <span className="text-muted-foreground">{t("noLimit")}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {values.map((entry) => (
        <li key={entry.measure}>
          <Measure value={entry.value} />
          {authority.length > 1 ? (
            <span className="ml-1 text-xs text-muted-foreground">
              {entry.measure}
            </span>
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
      <td className="px-3 py-2 text-right">
        <Authority authority={mandate.authority} pick={(m) => m.perCall} />
      </td>
      <td className="px-3 py-2 text-right">
        <Authority authority={mandate.authority} pick={(m) => m.perPeriod} />
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

const COLUMNS = [
  "mandate",
  "agent",
  "grantedBy",
  "purpose",
  "perCall",
  "perPeriod",
  "settled",
  "reserved",
  "remaining",
  "validTo",
  "status",
] as const;

export function MandatesLedger({ read }: { read: Read<MandateList> }) {
  const t = useTranslations("tools.mandates");
  const title = t("title");
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
        ) : read.value.mandates.length === 0 ? (
          <div className="flex flex-col gap-1 text-sm">
            <p data-state="empty">{t("empty")}</p>
            <p className="text-xs text-muted-foreground">{t("emptyDetail")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {read.value.truncatedAt === null ? null : (
              <p
                data-state="truncated"
                className="max-w-prose text-sm text-foreground"
              >
                {t("truncated", { shown: String(read.value.truncatedAt) })}
              </p>
            )}
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
          </div>
        )}
      </div>
    </section>
  );
}
