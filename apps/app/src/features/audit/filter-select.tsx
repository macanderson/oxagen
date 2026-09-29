"use client";
// A filter select that applies itself (rev1 audit.md, Events): the design has
// no Apply button beside Actor, Range and Result, so picking a value submits
// the GET form the select sits in and the page reads the record again with the
// new value in its URL. It is the app's Select (ADR-221), so the list opens on
// the translucent menu surface, where a native <select> opens the operating
// system's opaque menu.
//
// Only a pick from the open list applies: a click, a tap, or Enter on an
// option. Typing a letter on the closed trigger picks a matching option
// without opening the list, and applying that would reload the page and drop
// focus on each key (WCAG 3.2.2, audit.audit-prompt.md check 12). Such a match
// is ignored, so the trigger keeps its value. A keyboard user opens the list
// with Enter, Space or an arrow key, and picks with Enter.
//
// Base UI keeps the value in a hidden input named `name`, and the form sends
// that input. React writes the new value into it only when it renders again,
// so the pick renders at once through flushSync and the form is submitted
// after it, with the new value.
//
// Without script the list cannot open, so the filter cannot change. The
// form's Apply button, shown only then (events.tsx), still sends the values
// the page was drawn with.
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/** One choice in a filter. A disabled choice is listed but cannot be picked. */
type FilterOption = { value: string; label: string; disabled?: boolean };

export function FilterSelect({
  items,
  defaultValue,
  name,
  disabled,
  ...trigger
}: {
  items: readonly FilterOption[];
  /** The value the page was drawn with, from its URL. */
  defaultValue: string;
  /** The query parameter the value travels as. A select with no name sends nothing. */
  name?: string;
  disabled?: boolean;
  className?: string;
  "aria-label": string;
  "aria-describedby"?: string;
  "data-testid"?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Select
      items={items}
      value={value}
      name={name}
      disabled={disabled}
      inputRef={inputRef}
      onValueChange={(next, details) => {
        if (next === null || next === value) return;
        if (details.reason !== "item-press") return;
        flushSync(() => setValue(next));
        inputRef.current?.form?.requestSubmit();
      }}
    >
      <SelectTrigger {...trigger}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-max max-w-(--available-width) min-w-(--anchor-width)">
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            disabled={item.disabled}
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
