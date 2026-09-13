"use client";
// Tabs that switch content in place (a WAI-ARIA tablist with roving focus):
// Arrow keys, Home and End move between tabs and select them; only the selected
// tab is in the tab order. For tabs that are pages, use RouteTabs (plan §4.10):
// each tab there is a URL segment. These are for choices inside one page (an
// install method, a platform, an SDK language) that no URL should name.
import { type KeyboardEvent, type ReactNode, useRef } from "react";

export type TabItem<T extends string> = { id: T; label: ReactNode };

export function TabList<T extends string>({
  label,
  idPrefix,
  items,
  value,
  onChange,
  className,
  tabClassName,
}: {
  label: string;
  idPrefix: string;
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
  tabClassName?: (selected: boolean) => string;
}) {
  const tabsRef = useRef(new Map<T, HTMLButtonElement>());

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = items.length - 1;
    const target =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = items[target];
    if (!next) return;
    onChange(next.id);
    tabsRef.current.get(next.id)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={className}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) tabsRef.current.set(item.id, el);
              else tabsRef.current.delete(item.id);
            }}
            id={`${idPrefix}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(item.id);
            }}
            onKeyDown={(e) => {
              onKeyDown(e, index);
            }}
            className={tabClassName?.(selected)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  value,
  children,
  className,
}: {
  idPrefix: string;
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel`}
      aria-labelledby={`${idPrefix}-tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
}
