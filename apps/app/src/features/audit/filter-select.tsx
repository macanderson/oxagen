"use client";
// A filter select that applies itself (rev1 audit.md, Events): the design has
// no Apply button beside Actor, Range, Result and Rows, so picking a value
// submits the GET form the select sits in and the page reads the record again
// with the new value in its URL. The form keeps an Apply button for a browser
// running no script (events.tsx), so the filters work either way.
//
// A pick from the open list (a click, a tap, or Enter in the list) applies at
// once. A keyboard step on the closed select does not: Chromium fires `change`
// on each ArrowDown, and submitting then would reload the page and drop focus
// on every key (WCAG 3.2.2, audit.audit-prompt.md check 12). A value stepped
// to by keyboard applies on Enter, or when focus leaves the select.
import { type ComponentProps, useRef } from "react";

/** Keys that commit a choice from the select's open list. */
const COMMIT = new Set(["Enter", " "]);

export function FilterSelect(
  props: Omit<
    ComponentProps<"select">,
    "onChange" | "onKeyDown" | "onPointerDown" | "onBlur"
  >,
) {
  // The last key pressed on the select, or null after a pointer press.
  const lastKey = useRef<string | null>(null);
  // A value stepped to by keyboard that has not been applied yet.
  const stepped = useRef(false);
  const apply = (select: HTMLSelectElement) => {
    stepped.current = false;
    select.form?.requestSubmit();
  };
  return (
    <select
      {...props}
      onPointerDown={() => {
        lastKey.current = null;
      }}
      onKeyDown={(event) => {
        lastKey.current = event.key;
        if (event.key === "Enter" && stepped.current) {
          event.preventDefault();
          apply(event.currentTarget);
        }
      }}
      onChange={(event) => {
        if (lastKey.current === null || COMMIT.has(lastKey.current)) {
          apply(event.currentTarget);
          return;
        }
        stepped.current = true;
      }}
      onBlur={(event) => {
        if (stepped.current) apply(event.currentTarget);
      }}
    />
  );
}
