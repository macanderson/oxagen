"use client";
// A control the design draws whose backing does not exist yet (roadmap
// pages/steering.md, "Stub controls say what the product would do; nothing
// silently does nothing"). Pressing it says what Oxagen would do and what to
// do instead; it sends nothing.
import { type ComponentProps, useState } from "react";
import { Button } from "@/ui/button";

export function StubAction({
  label,
  note,
  variant = "outline",
  className,
  testId,
}: {
  label: string;
  /** What pressing it tells the person, already translated. */
  note: string;
  /** The kit Button's variant: `primary` only for the screen's one main action. */
  variant?: ComponentProps<typeof Button>["variant"];
  /** Layout classes the variant does not set. */
  className?: string;
  testId: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        data-testid={testId}
        aria-expanded={shown}
        onClick={() => {
          setShown(true);
        }}
        className={className}
      >
        {label}
      </Button>
      {shown ? (
        <p
          role="status"
          className="basis-full text-sm text-muted-foreground"
        >
          {note}
        </p>
      ) : null}
    </>
  );
}
