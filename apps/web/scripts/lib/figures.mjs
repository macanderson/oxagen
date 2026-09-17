// The figures a post can draw in its body. Each one is a build-time
// component that renders plain HTML on the house tokens (the rules are the
// "figures" block in assets/blog.css): no script, no image file, and no
// colour in the markup, only positions. A figure that plots numbers carries a
// visually hidden table of the same numbers, so a screen reader gets the data
// rather than a description of bars. Every number a post plots is one the
// post already states and cites; the caption names the source.
//
// Children are passed spread rather than as arrays, so React never asks for
// keys on a page that is rendered once and thrown away.

import { createElement as h } from "react";

/**
 * Where `v` sits between `min` and `max`, as a percentage clamped to 0-100.
 * @param {number} v
 * @param {number} min
 * @param {number} max
 */
export function scale(v, min, max) {
  if (max === min) return 0;
  const t = ((v - min) / (max - min)) * 100;
  return Number(Math.min(100, Math.max(0, t)).toFixed(2));
}

/**
 * `count` evenly spaced values from `min` to `max` inclusive.
 * @param {number} min
 * @param {number} max
 * @param {number} [count]
 */
export function evenTicks(min, max, count = 5) {
  return Array.from({ length: count }, (_, i) =>
    Number((min + ((max - min) * i) / (count - 1)).toFixed(2)),
  );
}

/** A datum's printed value: its `display` if it has one, else value and unit. */
export function valueText(d, unit = "") {
  return d.display ?? `${d.value}${unit}`;
}

const cls = (...names) => names.filter(Boolean).join(" ");

function Frame({ kind, title, caption, children }) {
  return h(
    "figure",
    { className: `fig fig-${kind}` },
    title ? h("p", { className: "fig-title" }, title) : null,
    children,
    caption ? h("figcaption", null, caption) : null,
  );
}

/**
 * The screen-reader copy of a data figure. The first cell of a row heads it.
 * The clipping box is a div around the table, because a table will not
 * shrink below its content and would widen the page on a phone.
 */
function DataTable({ head, rows }) {
  return h(
    "div",
    { className: "fig-sr" },
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h("tr", null, ...head.map((c) => h("th", { scope: "col" }, c))),
      ),
      h(
        "tbody",
        null,
        ...rows.map((r) =>
          h(
            "tr",
            null,
            ...r.map((c, i) =>
              i === 0 ? h("th", { scope: "row" }, c) : h("td", null, c),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * A tick label at `left` percent. A label at either end is anchored to that
 * end rather than centred on it, so it never hangs outside the plot.
 */
function Tick({ left, className, children }) {
  const edge = left <= 0 ? "is-start" : left >= 100 ? "is-end" : null;
  return h(
    "span",
    {
      className: cls(className, edge) || undefined,
      style: { left: `${left}%` },
    },
    children,
  );
}

/** A tick axis under a track: labels placed at their share of the range. */
function Axis({ ticks, min, max, unit = "" }) {
  return h(
    "div",
    { className: "fig-axis", "aria-hidden": "true" },
    ...ticks.map((t) => h(Tick, { left: scale(t, min, max) }, `${t}${unit}`)),
  );
}

/**
 * Horizontal bars with the value printed at the end of each. One magnitude,
 * one tone; `emph` lifts the bar the prose is about.
 * @param {{ title?: string, caption?: string, unit?: string, max?: number,
 *   head?: string[], data: Array<{ label: string, value: number,
 *   display?: string, emph?: boolean }> }} props
 */
export function Bars({ title, caption, unit = "", max, head, data = [] }) {
  const top = max ?? Math.max(0, ...data.map((d) => d.value));
  return h(
    Frame,
    { kind: "bars", title, caption },
    h(
      "div",
      { className: "fig-rows", "aria-hidden": "true" },
      ...data.map((d) =>
        h(
          "div",
          { className: cls("fig-row", d.emph && "is-emph") },
          h("span", { className: "fig-label" }, d.label),
          h(
            "span",
            { className: "fig-track" },
            h("span", {
              className: "fig-fill",
              style: { width: `${scale(d.value, 0, top)}%` },
            }),
          ),
          h("span", { className: "fig-value" }, valueText(d, unit)),
        ),
      ),
    ),
    h(DataTable, {
      head: head ?? ["", "Value"],
      rows: data.map((d) => [d.label, valueText(d, unit)]),
    }),
  );
}

/**
 * Two values per row on one scale, joined: a hollow dot for `fromLabel`, a
 * solid one for `toLabel`. For a before and after, or a system against a
 * reference, where the distance between them is the finding.
 * @param {{ title?: string, caption?: string, unit?: string, min?: number,
 *   max?: number, ticks?: number[], fromLabel: string, toLabel: string,
 *   rows: Array<{ label: string, from: number, to: number }> }} props
 */
export function Dumbbell({
  title,
  caption,
  unit = "",
  min = 0,
  max = 100,
  ticks,
  fromLabel,
  toLabel,
  rows = [],
}) {
  const key = (which, label) =>
    h(
      "span",
      { className: "fig-key-item" },
      h("span", { className: `fig-key fig-key-${which}` }),
      label,
    );
  return h(
    Frame,
    { kind: "dumbbell", title, caption },
    h(
      "div",
      { "aria-hidden": "true" },
      h(
        "p",
        { className: "fig-legend" },
        key("from", fromLabel),
        key("to", toLabel),
      ),
      h(
        "div",
        { className: "fig-rows" },
        ...rows.map((r) => {
          const a = scale(r.from, min, max);
          const b = scale(r.to, min, max);
          return h(
            "div",
            { className: "fig-row" },
            h("span", { className: "fig-label" }, r.label),
            h(
              "span",
              { className: "fig-track fig-track-line" },
              h("span", {
                className: "fig-span",
                style: {
                  left: `${Math.min(a, b)}%`,
                  width: `${Math.abs(b - a)}%`,
                },
              }),
              h("span", {
                className: "fig-dot fig-dot-from",
                style: { left: `${a}%` },
              }),
              h("span", {
                className: "fig-dot fig-dot-to",
                style: { left: `${b}%` },
              }),
            ),
            h(
              "span",
              { className: "fig-value" },
              `${r.from}${unit} to ${r.to}${unit}`,
            ),
          );
        }),
        h(
          "div",
          { className: "fig-row fig-row-axis" },
          h("span", { className: "fig-label" }),
          h(Axis, { ticks: ticks ?? evenTicks(min, max), min, max, unit }),
          h("span", { className: "fig-value" }),
        ),
      ),
    ),
    h(DataTable, {
      head: ["", fromLabel, toLabel],
      rows: rows.map((r) => [r.label, `${r.from}${unit}`, `${r.to}${unit}`]),
    }),
  );
}

/**
 * One to three lines over a shared x and y. Series are told apart by stroke
 * (solid, dashed, dotted) and named in a legend and at their last point, so
 * nothing rides on a hue. The plot is an SVG stretched to its box with
 * strokes that do not scale; every word is HTML, so labels stay readable at
 * phone width.
 * @param {{ title?: string, caption?: string, unit?: string, xLabel: string,
 *   xMin?: number, xMax: number, yMin?: number, yMax?: number,
 *   xTicks?: number[], yTicks?: number[],
 *   series: Array<{ label: string, end?: string, points: Array<[number, number]> }> }} props
 */
export function Curve({
  title,
  caption,
  unit = "",
  xLabel,
  xMin = 0,
  xMax,
  yMin = 0,
  yMax = 100,
  xTicks,
  yTicks,
  series = [],
}) {
  const xs = xTicks ?? evenTicks(xMin, xMax);
  const ys = yTicks ?? evenTicks(yMin, yMax);
  const px = (x) => scale(x, xMin, xMax);
  const py = (y) => scale(y, yMin, yMax);
  const lineKey = (s, i) =>
    h(
      "span",
      { className: "fig-key-item" },
      h("span", { className: `fig-key fig-key-line fig-series-${i}` }),
      s.label,
    );
  // The axis ticks are a visual convenience and are routinely sparser than the
  // data — the compounding curve plots 21 samples behind 5 ticks. Building the
  // table off `xs` would drop the other 16 from every series, so the rows come
  // from the union of the plotted x-coordinates and the ticks are left to the
  // axis alone.
  const sampleXs = [
    ...new Set(series.flatMap((s) => s.points.map(([x]) => x))),
  ].sort((a, b) => a - b);
  const rowsFor = (sampleXs.length > 0 ? sampleXs : xs).map((x) => [
    `${x}`,
    ...series.map((s) => {
      const p = s.points.find(([px0]) => px0 === x);
      return p ? `${p[1]}${unit}` : "";
    }),
  ]);
  return h(
    Frame,
    { kind: "curve", title, caption },
    h(
      "div",
      { "aria-hidden": "true" },
      series.length > 1
        ? h("p", { className: "fig-legend" }, ...series.map(lineKey))
        : null,
      h(
        "div",
        { className: "fig-chart" },
        h(
          "div",
          { className: "fig-yaxis" },
          ...ys.map((y) =>
            h("span", { style: { bottom: `${py(y)}%` } }, `${y}${unit}`),
          ),
        ),
        h(
          "div",
          { className: "fig-plot" },
          ...ys.map((y) =>
            h("span", {
              className: "fig-grid",
              style: { bottom: `${py(y)}%` },
            }),
          ),
          h(
            "svg",
            {
              viewBox: "0 0 100 100",
              preserveAspectRatio: "none",
              focusable: "false",
            },
            ...series.map((s, i) =>
              h("polyline", {
                className: `fig-line fig-series-${i}`,
                vectorEffect: "non-scaling-stroke",
                points: s.points
                  .map(
                    ([x, y]) => `${px(x)},${Number((100 - py(y)).toFixed(2))}`,
                  )
                  .join(" "),
              }),
            ),
          ),
          ...series.flatMap((s) => {
            const last = s.points.at(-1);
            if (!last || !s.end) return [];
            const at = { left: `${px(last[0])}%`, bottom: `${py(last[1])}%` };
            return [
              h("span", { className: "fig-dot fig-dot-to", style: at }),
              h("span", { className: "fig-end", style: at }, s.end),
            ];
          }),
        ),
        h(Axis, { ticks: xs, min: xMin, max: xMax }),
      ),
      h("p", { className: "fig-axis-title" }, xLabel),
    ),
    h(DataTable, {
      head: [xLabel, ...series.map((s) => s.label)],
      rows: rowsFor,
    }),
  );
}

/**
 * A process as numbered steps joined by arrows, in a row when the column is
 * wide enough and a column when it is not. `loop` draws the return from the
 * last step to the first and names it. `emph` marks the step the post
 * argues about.
 * @param {{ title?: string, caption?: string, loop?: string,
 *   steps: Array<{ label: string, detail?: string, emph?: boolean }> }} props
 */
export function Flow({ title, caption, loop, steps = [] }) {
  return h(
    Frame,
    { kind: "flow", title, caption },
    h(
      "ol",
      { className: "fig-flow", style: { "--n": steps.length } },
      ...steps.map((s, i) =>
        h(
          "li",
          { className: cls("fig-step", s.emph && "is-emph") },
          h(
            "span",
            { className: "fig-step-n", "aria-hidden": "true" },
            String(i + 1).padStart(2, "0"),
          ),
          h("span", { className: "fig-step-label" }, s.label),
          s.detail
            ? h("span", { className: "fig-step-detail" }, s.detail)
            : null,
        ),
      ),
    ),
    loop
      ? h(
          "p",
          { className: "fig-loop", style: { "--n": steps.length } },
          h("span", null, loop),
        )
      : null,
  );
}

/**
 * A rising sequence of tiers: each rung is taller than the one before, for
 * an ordering the post names on `axis` (blast radius, cost, reach).
 * @param {{ title?: string, caption?: string, axis?: string,
 *   steps: Array<{ label: string, detail?: string }> }} props
 */
export function Ladder({ title, caption, axis, steps = [] }) {
  return h(
    Frame,
    { kind: "ladder", title, caption },
    h(
      "ol",
      { className: "fig-ladder", style: { "--n": steps.length } },
      ...steps.map((s, i) =>
        h(
          "li",
          { className: "fig-rung", style: { "--i": i + 1 } },
          h("span", { className: "fig-rung-bar", "aria-hidden": "true" }),
          h("span", { className: "fig-rung-label" }, s.label),
          s.detail
            ? h("span", { className: "fig-rung-detail" }, s.detail)
            : null,
        ),
      ),
    ),
    axis ? h("p", { className: "fig-ladder-axis" }, axis) : null,
  );
}

/**
 * Facts as validity intervals on one clock, with an optional "as of" marker
 * dropped through every row. A fact that no longer holds is drawn hollow.
 * @param {{ title?: string, caption?: string, start: number, end: number,
 *   ticks?: Array<{ at: number, label: string }>,
 *   marker?: { at: number, label: string },
 *   rows: Array<{ label: string, when: string, from: number, to: number, ended?: boolean }> }} props
 */
/**
 * What a timeline row says for a screen reader. With no marker there is no
 * instant to judge against, so the author's `ended` flag is all there is. With
 * one, the flag is the wrong question: it is a fact about the row, while the
 * marker asks whether the row covers one instant. Reading `ended` instead
 * reversed both rows of the ontology figure — a January-to-March fact marked
 * `ended` reads "No longer holds" at a mid-March marker it plainly contains,
 * and the April-onward row reads "Holds" months before it starts.
 *
 * A row is half-open `[from, to)`, except that a row reaching the end of the
 * timeline is still running and includes it: without that, "Today" (`at` equal
 * to `end`) falls outside every current row.
 * @param {{ from?: number, to?: number, ended?: boolean }} row
 * @param {{ at: number, label: string } | undefined} marker
 * @param {number} end
 */
function statusAt(row, marker, end) {
  if (!marker) return row.ended ? "No longer holds" : "Holds";
  const { from, to } = row;
  if (from === undefined || to === undefined) {
    return row.ended ? "No longer holds" : "Holds";
  }
  const ongoing = to >= end;
  if (from <= marker.at && (marker.at < to || ongoing)) return "Holds";
  return to <= marker.at ? "No longer holds" : "Not yet";
}

/**
 * How close, in percent of the track, a tick may sit to the marker before its
 * label collides with the marker's. Both labels are centred on their position
 * and the axis is one absolutely positioned row, so nothing pushes them apart:
 * a "Today" marker 4 percent from an "Oct" tick renders as "TodayOct". The
 * marker wins, because it is the instant the rest of the figure is read at.
 */
export const MARKER_CLEARANCE = 8;

/**
 * The ticks to draw under a track: the author's, less any the marker's own
 * label would overlap.
 * @param {Array<{ at: number, label: string }>} ticks
 * @param {{ at: number, label: string } | undefined} marker
 * @param {number} start
 * @param {number} end
 */
export function visibleTicks(ticks, marker, start, end) {
  if (!marker) return ticks;
  const markerAt = scale(marker.at, start, end);
  return ticks.filter(
    (t) => Math.abs(scale(t.at, start, end) - markerAt) >= MARKER_CLEARANCE,
  );
}

export function Timeline({
  title,
  caption,
  start,
  end,
  ticks = [],
  marker,
  rows = [],
}) {
  const at = (v) => `${scale(v, start, end)}%`;
  const span = Math.abs(end - start);
  const markerLine = marker
    ? h("span", { className: "fig-marker", style: { left: at(marker.at) } })
    : null;
  return h(
    Frame,
    { kind: "timeline", title, caption },
    h(
      "div",
      { className: "fig-rows", "aria-hidden": "true" },
      ...rows.map((r) =>
        h(
          "div",
          { className: "fig-row" },
          h(
            "span",
            { className: "fig-label" },
            r.label,
            h("span", { className: "fig-when" }, r.when),
          ),
          h(
            "span",
            { className: "fig-track" },
            h("span", {
              className: cls("fig-interval", r.ended && "is-ended"),
              style: {
                left: at(Math.min(r.from, r.to)),
                width: `${scale(Math.abs(r.to - r.from), 0, span)}%`,
              },
            }),
            markerLine,
          ),
        ),
      ),
      h(
        "div",
        { className: "fig-row fig-row-axis" },
        h("span", { className: "fig-label" }),
        h(
          "span",
          { className: "fig-axis" },
          ...visibleTicks(ticks, marker, start, end).map((t) =>
            h(Tick, { left: scale(t.at, start, end) }, t.label),
          ),
          marker
            ? h(
                Tick,
                {
                  left: scale(marker.at, start, end),
                  className: "fig-marker-label",
                },
                marker.label,
              )
            : null,
        ),
      ),
    ),
    h(DataTable, {
      head: ["Fact", "Holds", marker ? `Status (${marker.label})` : "Status"],
      rows: rows.map((r) => [r.label, r.when, statusAt(r, marker, end)]),
    }),
  );
}

/**
 * Typed relations between classes, one per row: a class, the relation's
 * name on an arrow with the constraints it carries, the class it points at.
 * @param {{ title?: string, caption?: string,
 *   edges: Array<{ from: string, rel: string, to: string, notes?: string[] }> }} props
 */
export function Schema({ title, caption, edges = [] }) {
  return h(
    Frame,
    { kind: "schema", title, caption },
    h(
      "ul",
      { className: "fig-schema" },
      ...edges.map((e) =>
        h(
          "li",
          { className: "fig-edge" },
          h("span", { className: "fig-node" }, e.from),
          h(
            "span",
            { className: "fig-rel" },
            h("span", { className: "fig-rel-name" }, e.rel),
            h("span", { className: "fig-rel-line", "aria-hidden": "true" }),
            e.notes?.length
              ? h(
                  "span",
                  { className: "fig-rel-notes" },
                  ...e.notes.map((n) => h("span", null, n)),
                )
              : null,
          ),
          h("span", { className: "fig-node" }, e.to),
        ),
      ),
    ),
  );
}

/**
 * Training generations side by side: each generation is a stack of blocks,
 * solid for real data and hollow for generated data, so two retention
 * policies can be read against each other. Illustrative, not measured.
 * @param {{ title?: string, caption?: string, realLabel?: string,
 *   syntheticLabel?: string,
 *   rows: Array<{ label: string, outcome?: string, gens: Array<[number, number]> }> }} props
 */
export function Generations({
  title,
  caption,
  realLabel = "Real data",
  syntheticLabel = "Generated data",
  rows = [],
}) {
  const blocks = (count, kind) =>
    Array.from({ length: count }, () =>
      h("span", { className: `fig-block fig-block-${kind}` }),
    );
  return h(
    Frame,
    { kind: "generations", title, caption },
    h(
      "p",
      { className: "fig-legend", "aria-hidden": "true" },
      h(
        "span",
        { className: "fig-key-item" },
        h("span", { className: "fig-key fig-key-to" }),
        realLabel,
      ),
      h(
        "span",
        { className: "fig-key-item" },
        h("span", { className: "fig-key fig-key-from" }),
        syntheticLabel,
      ),
    ),
    h(
      "div",
      { className: "fig-gen-rows" },
      ...rows.map((r) =>
        h(
          "div",
          { className: "fig-gen-row" },
          h(
            "p",
            { className: "fig-gen-head" },
            h("span", { className: "fig-gen-label" }, r.label),
            r.outcome
              ? h("span", { className: "fig-gen-outcome" }, r.outcome)
              : null,
          ),
          h(
            "ol",
            {
              className: "fig-gens",
              style: {
                "--max": Math.max(1, ...r.gens.map(([a, b]) => a + b)),
              },
            },
            ...r.gens.map(([real, synthetic], i) =>
              h(
                "li",
                {
                  className: "fig-gen",
                  "aria-label": `Generation ${i}: ${real} ${realLabel.toLowerCase()}, ${synthetic} ${syntheticLabel.toLowerCase()}`,
                },
                h(
                  "span",
                  { className: "fig-stack", "aria-hidden": "true" },
                  ...blocks(real, "real"),
                  ...blocks(synthetic, "synthetic"),
                ),
                h(
                  "span",
                  { className: "fig-gen-n", "aria-hidden": "true" },
                  `Gen ${i}`,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Every figure, keyed by the name a post uses for it. */
export const FIGURES = {
  Bars,
  Dumbbell,
  Curve,
  Flow,
  Ladder,
  Timeline,
  Schema,
  Generations,
};
