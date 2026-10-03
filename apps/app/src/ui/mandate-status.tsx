// A mandate's status (#3152): the word the record stores, and under it what
// the validity window says at the instant the answer was read. Shared for the
// reason the scope and the authority are. The Agents table worked out that a
// granted mandate had not started and the Tools ledger did not, and neither
// worked out that one had ended, so the same row read three ways across two
// pages. The window's state comes from `windowOf` in `@/data/contracts/
// mandates`, the one function that answers it, and this is the one component
// that prints it. §2 lets this layer import that module's types only, so the
// caller passes the answer in.
//
// **The stored word stays.** `mandates.status` is a cached answer the hourly
// expiry job keeps, so a row whose window has closed still says `active` for up
// to an hour while the gate refuses it, and a row granted ahead of its start
// says `active` before the gate will take it. The record does say active, and
// `list_mandates` returns it so. Relabelling the row would make the page and
// the list disagree about what the record holds, so the word is printed as
// stored and the window's state goes on a line under it.
import { useTranslations } from "next-intl";
import type { MandateRow, MandateWindow } from "@/data/contracts/mandates";
import { useFormatter } from "./formatter";

export function MandateStatus({
  mandate,
  windowState: state,
}: {
  mandate: Pick<MandateRow, "status" | "validFrom" | "validTo">;
  /**
   * `windowOf(mandate, asOf)`, with `asOf` the instant the answer was counted
   * at, so the window is judged against the instant the balances beside it
   * describe and no clock is read during render.
   */
  windowState: MandateWindow | null;
}) {
  const t = useTranslations("ui.mandateStatus");
  const format = useFormatter();
  const day = (instant: string) =>
    format.dateTime(new Date(instant), { dateStyle: "medium" });
  return (
    <div
      data-mandate-status={mandate.status}
      data-effect={state ?? undefined}
      className="flex flex-col"
    >
      <span>{t(`status.${mandate.status}`)}</span>
      {state === null ? null : (
        <span
          data-state={state}
          className="whitespace-nowrap text-xs text-muted-foreground md:truncate"
        >
          {state === "upcoming"
            ? t("startsOn", { date: day(mandate.validFrom) })
            : t("endedOn", { date: day(mandate.validTo) })}
        </span>
      )}
    </div>
  );
}
