"use client";
// A control the design draws whose backing does not exist yet (roadmap
// pages/steering.md, "Stub controls say what the product would do; nothing
// silently does nothing"). Pressing it says what Oxagen would do and what to
// do instead; it sends nothing.
import { useState } from "react";

export function StubAction({
  label,
  note,
  className,
  testId,
}: {
  label: string;
  /** What pressing it tells the person, already translated. */
  note: string;
  className: string;
  testId: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        aria-expanded={shown}
        onClick={() => {
          setShown(true);
        }}
        className={className}
      >
        {label}
      </button>
      {shown ? (
        <p
          role="status"
          className="basis-full text-[12.5px] text-muted-foreground"
        >
          {note}
        </p>
      ) : null}
    </>
  );
}
