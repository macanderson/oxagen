/**
 * The shape limits of a chart the in-app assistant draws (`render_chart`).
 *
 * Two readers hold a chart to these numbers: the contract, which validates the
 * tool call with zod 3, and the app's renderer, which validates the fenced
 * block in the reply with zod 4 before it draws anything. This module imports
 * nothing, so the browser bundle can read it without the contract registry.
 */

/** The fence language that marks a chart block in an assistant reply. */
export const CHART_FENCE_LANGUAGE = "oxagen-chart";

/** Chart kinds the renderer draws. */
export const CHART_KINDS = ["line", "area", "bar", "stacked_bar"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/**
 * How a chart or tile prints its numbers. `percent` reads a 0..1 ratio,
 * `duration` reads milliseconds, and `currency` reads a decimal amount in the
 * ISO 4217 code the format names.
 */
export const CHART_FORMAT_KINDS = [
  "number",
  "currency",
  "percent",
  "duration",
] as const;
export type ChartFormatKind = (typeof CHART_FORMAT_KINDS)[number];

/**
 * The most a chart block may hold. Five series matches the five chart hues,
 * so no two series share a colour. `bytes` caps the serialized spec, which is
 * what the reply carries and what the renderer parses.
 */
export const CHART_LIMITS = {
  charts: 6,
  tiles: 8,
  series: 5,
  rows: 100,
  titleChars: 120,
  labelChars: 80,
  noteChars: 120,
  unitChars: 24,
  sourceChars: 200,
  bytes: 16_384,
} as const;
