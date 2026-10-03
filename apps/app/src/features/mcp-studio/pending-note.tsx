// The one-line note under a control whose capability has not merged (#4678,
// part 2). The control renders disabled and names this note with
// aria-describedby. The note carries the capability's name as
// `data-capability` and the work that builds it as `data-gap`, so a reader of
// the DOM can follow the control to that work. A control that waits on a fix
// to a shipped capability rather than a new one names no capability. Part 3
// removes the note when the work merges.
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
  /** The registered capability name, such as `try_studio_tool`, if one is new. */
  capability?: string;
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
      className="text-sm text-muted-foreground"
    >
      {children}
    </p>
  );
}
