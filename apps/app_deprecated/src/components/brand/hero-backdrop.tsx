import { HexField } from "@/components/ui/hex-field";
import { cn } from "@/lib/utils";

/**
 * HeroBackdrop — the shared ember hero backdrop. The docs landing page and the
 * app render the same three layers, so both read as one brand surface. All
 * three ignore pointer events and stack in this order:
 *
 *   1. `.ox-hero-grid`  — an ambient 46px lattice masked to a soft radial fade.
 *   2. `.ox-hero-orb`   — a blurred, slowly-pulsing ember light source.
 *   3. `HexField`       — the logomark hex-constellation, gently floating.
 *
 * All layers live at `-z-10`; the parent must establish a stacking/clip context
 * (`relative isolate overflow-hidden`) and render real content above at `z-10`.
 * The helper classes + keyframes are defined in @oxagen/ui/styles/globals.css
 * and motion is auto-suppressed under prefers-reduced-motion.
 *
 * `intensity` tunes how present the field reads:
 *   - "hero"    — auth / onboarding (full-strength, front-and-centre).
 *   - "ambient" — behind the in-app shell, where floating panels cover most of
 *                 it; dialled down so the sliver around the panels just glows.
 */
export function HeroBackdrop({
  intensity = "hero",
  className,
}: {
  intensity?: "hero" | "ambient";
  className?: string;
}) {
  const ambient = intensity === "ambient";
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 overflow-hidden",
        className,
      )}
    >
      <div className="ox-hero-grid absolute inset-0" />
      <div
        className={cn(
          "ox-hero-orb absolute left-1/2 top-[-12%] -translate-x-1/2",
          ambient ? "h-[420px] w-[680px] opacity-50" : "h-[520px] w-[820px]",
        )}
      />
      <HexField
        className={cn(
          "ox-hex-float absolute inset-0 h-full w-full text-foreground",
          ambient ? "opacity-40" : "opacity-70",
        )}
      />
    </div>
  );
}
