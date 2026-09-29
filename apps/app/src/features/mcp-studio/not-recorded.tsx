// The state a Studio value takes while the work behind it has not landed
// (#4678, "Seams other lanes replace"). The element carries the owning issue
// as `data-gap`, so a reader of the DOM can follow it to the work that fills
// it, and the page never prints a zero or an empty list the record cannot
// back.
//
// The names are not `NotRecorded`: INV-18 reserves that tag for the
// whole-page rows of `src/data/unrecorded.ts`, and a Studio gap is one value
// on a page that exists.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { type StudioGap, studioGapRef } from "./gaps";

/** A block that says what is missing and why, in place of a section's body. */
export function StudioNotRecorded({
  gap,
  testId,
  children,
}: {
  gap: StudioGap;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      role="note"
      data-state="not-recorded"
      data-gap={studioGapRef(gap)}
      data-testid={testId}
      className="flex flex-col gap-1 rounded-lg border border-dashed border-border px-3.5 py-3 text-[13px] text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** One value the record does not hold yet, inline in a table or a fact list. */
export function StudioNotRecordedValue({ gap }: { gap: StudioGap }) {
  const t = useTranslations("mcpStudio");
  return (
    <span
      data-state="not-recorded"
      data-gap={studioGapRef(gap)}
      className="text-muted-foreground"
    >
      {t("notRecorded")}
    </span>
  );
}
