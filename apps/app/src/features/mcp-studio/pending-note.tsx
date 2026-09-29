// The one-line note under a control whose capability has not merged (#4678,
// part 2). The control renders disabled and names this note with
// aria-describedby. The note carries the capability's name as
// `data-capability` and the work that builds it as `data-gap`, so a reader of
// the DOM can follow the control to that work. Part 3 removes the note when
// the capability merges.
import type { ReactNode } from "react";
import { type StudioGap, studioGapRef } from "./gaps";

export function PendingNote({
  id,
  capability,
  gap,
  testId,
  children,
}: {
  id: string;
  /** The registered capability name, such as `try_studio_tool`. */
  capability: string;
  gap: StudioGap;
  testId: string;
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      data-state="not-available"
      data-capability={capability}
      data-gap={studioGapRef(gap)}
      data-testid={testId}
      className="text-[12.5px] text-muted-foreground"
    >
      {children}
    </p>
  );
}
