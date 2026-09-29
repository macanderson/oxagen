"use client";
// A list's filter or sort on the app's Select (ADR-221): a trigger that shows
// the chosen label, and a list that opens on the translucent menu surface, as
// the mockup draws every single select on a desktop. A native <select> opens
// the operating system's menu, which is opaque.
//
// Values are strings, and "" is the "All" choice a filter offers first. Base
// UI counts "" as no value, so the trigger wears its placeholder colour while
// it still reads the "All" label from `items`. Picking the choice already
// shown hands on nothing, as a native select did. `name` puts the value in a
// hidden input, so a form that holds the select carries it.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

export type ListSelectItem = { value: string; label: string };

export function ListSelect({
  items,
  value,
  onValue,
  name,
  disabled,
  size,
  ...trigger
}: {
  items: readonly ListSelectItem[];
  value: string;
  onValue: (next: string) => void;
  name?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "data-testid"?: string;
}) {
  return (
    <Select
      items={items}
      value={value}
      name={name}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onValue(next);
      }}
    >
      <SelectTrigger size={size} {...trigger}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
