// The one state badge (mockup `.b`, engine.css, ADR-132): a dot and a word in
// a tinted pill, so the state survives greyscale and reads the same on every
// page. The hue is a state hue and never the gold: gold is identity.
//
// `.b { gap:5px; font-size:11px; font-weight:600; letter-spacing:.02em;
// padding:2px 7px; border-radius:6px; border:1px solid }`, and `.b-<state>`
// puts the state hue on the ink, 42% of it on the border and 11% behind.
// `.b-q` is the quiet pill: muted ink, the hairline, the wash. `.b-tier` is
// the mono, lowercase variant an enforcement tier takes.
import type { ReactNode } from "react";

/** The mockup's state vocabulary; `quiet` is `.b-q`. */
export type BadgeTone =
  | "allowed"
  | "approval"
  | "denied"
  | "proven"
  | "failed"
  | "critical"
  | "quiet";

const TONE: Record<BadgeTone, string> = {
  allowed: "border-success/40 bg-success/10 text-success",
  approval: "border-info/40 bg-info/10 text-info",
  denied: "border-warning/40 bg-warning/10 text-warning",
  proven: "border-proven/40 bg-proven/10 text-proven",
  failed: "border-error/40 bg-error/10 text-error-ink",
  critical: "border-critical/40 bg-critical/10 text-critical",
  quiet: "border-border bg-hl text-muted-foreground",
};

const badgeBase =
  "inline-flex items-center gap-[5px] whitespace-nowrap rounded-md border px-[7px] py-0.5 text-[11px] font-semibold leading-normal tracking-[0.02em]";

export function Badge({
  tone,
  dot = true,
  mono = false,
  children,
  ...rest
}: {
  tone: BadgeTone;
  /**
   * `.b .d`: the 5px dot in the state hue. Off for a kind or a tier;
   * `"pulse"` breathes, for a state that is happening right now.
   */
  dot?: boolean | "pulse";
  /** `.b-tier`: mono, lowercase, regular weight. */
  mono?: boolean;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <span
      {...rest}
      className={`${badgeBase} ${TONE[tone]} ${mono ? "font-mono text-[10.5px] font-medium lowercase" : ""}`}
    >
      {dot ? (
        <span
          aria-hidden="true"
          data-pulse={dot === "pulse" ? "true" : undefined}
          className={`size-[5px] flex-none rounded-full bg-current ${dot === "pulse" ? "animate-pulse" : ""}`}
        />
      ) : null}
      {children}
    </span>
  );
}
