"use client";
// The Grant panel's Valid row, `2026-09-01 → 2026-12-31` as the design prints
// it. A client component because the day an instant falls on is a question
// about the viewer's zone, and the zone the shell's provider holds is the one
// every other date on the page is drawn in; a server component reads only the
// request default (src/ui/formatter.ts).
import { useTimeZone, useTranslations } from "next-intl";
import { useFormatter } from "@/ui/formatter";
import { validDays } from "./view";

export function ValidWindow({
  validFrom,
  validTo,
}: {
  validFrom: string;
  validTo: string;
}) {
  const t = useTranslations("mandate.grant");
  const format = useFormatter();
  const timeZone = useTimeZone();
  const days =
    timeZone === undefined
      ? { from: null, to: null }
      : validDays({ validFrom, validTo }, timeZone);
  const instant = (value: string) =>
    format.dateTime(new Date(value), {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <span data-testid="valid-window">
      {t("validWindow", {
        from: days.from ?? instant(validFrom),
        to: days.to ?? instant(validTo),
      })}
    </span>
  );
}
