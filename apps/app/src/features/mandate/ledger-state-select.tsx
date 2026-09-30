"use client";
// The ledger's State filter on the app's Select (ADR-221), so its list opens
// on the translucent menu surface where a native <select> opens the operating
// system's opaque menu. A pick waits for the form's Search button: Base UI
// keeps the value in a hidden input named "state", which the GET form sends.
// The ledger keys this select on the URL's state, so a navigation that
// changes it, such as Clear, draws the select again from the new value.
//
// Without script the list cannot open, so the state cannot change. Search
// still sends the search text and the state the page was drawn with.
import { useState } from "react";
import { ListSelect, type ListSelectItem } from "@/ui/list-select";

export function LedgerStateSelect({
  items,
  defaultValue,
  ...trigger
}: {
  items: readonly ListSelectItem[];
  /** The state the page was drawn with, or "" for every state. */
  defaultValue: string;
  id: string;
  className?: string;
  "aria-labelledby": string;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <ListSelect
      name="state"
      items={items}
      value={value}
      onValue={setValue}
      {...trigger}
    />
  );
}
