// The status tones every badge speaks, mapped onto house tokens only
// (success / info / warning / error, and the neutral muted ramp). Colour is
// never the only signal: every chip also carries an icon and a text label.
// Label text stays on the ink or muted ink, because the warning and error hues
// fall under 4.5:1 as small text on the paper ground; the hue lives on the
// icon, the hairline and a faint tint instead.
export type Tone =
  | "neutral"
  | "success"
  | "info"
  | "warning"
  | "error"
  | "critical";

export const CHIP_TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  success: "border-success/45 bg-success/10 text-foreground",
  info: "border-info/45 bg-info/10 text-foreground",
  warning: "border-warning/50 bg-warning/10 text-foreground",
  error: "border-error/50 bg-error/10 text-foreground",
  critical: "border-error bg-error text-error-foreground",
};

export const ICON_TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
  critical: "text-error-foreground",
};

/** Ink for a glyph that stands alone, with no chip behind it (Hazard). */
export const GLYPH_TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
  critical: "text-error",
};
