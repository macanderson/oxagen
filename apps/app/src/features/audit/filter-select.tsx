"use client";
// A filter select that applies itself (rev1 audit.md, Events): the design has
// no Apply button beside Actor, Range, Result and Rows, so a change submits the
// GET form the select sits in and the page reads the record again with the new
// value in its URL. The form keeps an Apply button for a browser running no
// script (events.tsx), so the filters work either way.
import type { ComponentProps } from "react";

export function FilterSelect(
  props: Omit<ComponentProps<"select">, "onChange">,
) {
  return (
    <select
      {...props}
      onChange={(event) => event.currentTarget.form?.requestSubmit()}
    />
  );
}
