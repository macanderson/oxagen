"use client";

import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTheme } from "next-themes";

/**
 * The System / Light / Dark control, the way vercel.com's footer carries it:
 * three icon buttons in one pill, the chosen one on a raised chip. oxagen.sh
 * draws the same control in plain HTML (apps/web/assets/oxagen.css,
 * `.theme-switch`), in the same order with the same icons; change both
 * together.
 *
 * next-themes stores the choice in localStorage under "theme", and "system"
 * follows the OS live. It is a radio group, so one tab stop reaches it and the
 * arrow keys move the choice.
 *
 * Used in the landing footer and passed to Fumadocs as the sidebar's
 * `themeSwitch` slot, which hands it a `className`.
 */

const CHOICES: ReadonlyArray<{ value: string; label: string; icon: ReactNode }> = [
  {
    value: "system",
    label: "System",
    icon: (
      <>
        <rect width="20" height="14" x="2" y="3" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  },
];

export function ThemeSwitcher({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  // The stored choice is only readable in the browser, so the server render
  // and the first client render show no chip, and the two match.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? "system") : null;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      e.key
    ];
    if (!step) return;
    e.preventDefault();
    const at = Math.max(
      0,
      CHOICES.findIndex((c) => c.value === current),
    );
    const next = (at + step + CHOICES.length) % CHOICES.length;
    const choice = CHOICES[next];
    if (!choice) return;
    setTheme(choice.value);
    e.currentTarget
      .querySelectorAll<HTMLButtonElement>("button")
      [next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className={`inline-flex gap-0.5 rounded-full border border-border bg-background p-[3px] ${className}`}
    >
      {CHOICES.map((c) => {
        const on = current === c.value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c.label}
            title={c.label}
            tabIndex={on || (current === null && c.value === "system") ? 0 : -1}
            onClick={() => setTheme(c.value)}
            className={`grid size-7 place-items-center rounded-full transition-colors ${
              on
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-[15px]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {c.icon}
            </svg>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The Fumadocs sidebar slot. The sidebar passes classes that flatten its own
 * pill into a row of square buttons; this control keeps its own shape, so
 * only the right alignment is taken.
 */
export function SidebarThemeSwitcher() {
  return <ThemeSwitcher className="ms-auto" />;
}
