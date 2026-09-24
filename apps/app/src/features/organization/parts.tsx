// The pieces the Organization tabs draw from: an instant printed as a date,
// the words a cell prints when the record has no value for it, and the class
// recipe for the line a section prints in place of a table it has no rows for.
import { useTranslations } from "next-intl";
import { useFormatter } from "@/ui/formatter";

export const emptyLine = "text-sm text-muted-foreground";

/** A note under a table: the mockup's `.note`, a gold rule and one fact. */
export const note =
  "border-l-2 border-gold pl-3 text-[13px] leading-relaxed text-muted-foreground";

/**
 * A warning in a dialog: the mockup's `.warn`, the critical hue as a hairline
 * and a wash behind body ink, for what a write would end or refuse.
 */
export const warn =
  "rounded-[10px] border border-critical/45 bg-critical/10 px-3.5 py-[11px] text-[12.5px] text-foreground";

export function DateCell({ iso }: { iso: string }) {
  const format = useFormatter();
  return (
    <time dateTime={iso}>
      {format.dateTime(new Date(iso), { dateStyle: "medium" })}
    </time>
  );
}

/**
 * A cell whose value no contract records yet. It says so in the dim ink,
 * never a zero or a dash that could read as a value, and carries
 * `data-not-recorded` so a test and the audit can find every one.
 */
export function NotRecordedValue() {
  const t = useTranslations("organization");
  return (
    <span data-not-recorded="" className="text-[11.5px] text-dim">
      {t("notRecorded")}
    </span>
  );
}
