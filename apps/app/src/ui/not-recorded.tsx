// The one "not recorded" state (ARCHITECTURE.md §3.6): catalog prose for a row
// of UNRECORDED, with the backend gap carried only as a data attribute. A page
// that renders this renders nothing else below its header.
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
