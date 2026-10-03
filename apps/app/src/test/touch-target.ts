// A control's touch target at phone width (ARCHITECTURE.md §1.2). phone.css
// writes the 44px floor on the spacing scale, `calc(var(--spacing) * 11)`
// (#5283), and jsdom computes neither var() nor calc(), so a computed
// min-height reads back as that string. This resolves it with the kit's
// spacing unit, read from the synced tokens, so the check still fails if a
// change to the unit takes a control under 44px.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

/** Apple's and WCAG 2.5.5's touch target, in CSS px. */
export const TOUCH_TARGET_PX = 44;

/** The kit's spacing unit in px: `--ox-space`, which Tailwind's `--spacing` reads. */
function spacingPx(): number {
  // Vitest runs from apps/app.
  const tokens = readFileSync(
    path.join(process.cwd(), "../../packages/ui/src/styles/house-tokens.css"),
    "utf8",
  );
  const unit = /--ox-space:\s*(\d*\.?\d+)(rem|px)\s*;/.exec(tokens);
  if (!unit) throw new Error("house-tokens.css sets no --ox-space");
  return Number(unit[1]) * (unit[2] === "rem" ? 16 : 1);
}

const SPACING_PX = spacingPx();

/** A computed length in px: `44px`, or a spacing step such as `calc(var(--spacing) * 11)`. NaN for anything else. */
export function lengthPx(value: string): number {
  const text = value.trim();
  const px = /^(-?\d*\.?\d+)px$/.exec(text);
  if (px) return Number(px[1]);
  const step = /^calc\(\s*var\(--spacing\)\s*\*\s*(\d*\.?\d+)\s*\)$/.exec(text);
  if (step) return Number(step[1]) * SPACING_PX;
  return Number.NaN;
}

/** Fails unless `value` resolves to a length of at least 44px. */
export function expectTouchTarget(value: string): void {
  expect(
    lengthPx(value),
    `${value} resolves to a ${String(TOUCH_TARGET_PX)}px touch target`,
  ).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
}
