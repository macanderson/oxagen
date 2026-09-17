// The one "not recorded" state (ARCHITECTURE.md §3.6): catalog prose for a row
// of UNRECORDED, with the backend gap carried only as a data attribute. A page
// with no section at all renders this and nothing else below its header; a
// page part-built renders it beneath the sections it does have, naming what is
// still missing.
import { useTranslations } from "next-intl";
import { type UnrecordedKey, unrecordedRow } from "@/data/unrecorded";

export function NotRecorded({ section }: { section: UnrecordedKey }) {
  const t = useTranslations("unrecorded");
  const { gap } = unrecordedRow(section);
  return (
    <p
      data-testid="not-recorded"
      data-section={section}
      {...(gap === null ? {} : { "data-gap": gap })}
      className="max-w-prose text-sm text-muted-foreground"
    >
      {t(section)}
    </p>
  );
}
