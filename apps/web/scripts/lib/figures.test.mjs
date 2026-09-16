import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Bars,
  Curve,
  Dumbbell,
  evenTicks,
  FIGURES,
  Flow,
  Generations,
  Ladder,
  scale,
  Schema,
  Timeline,
  valueText,
} from "./figures.mjs";
import { renderMdx } from "./mdx.mjs";

const render = (Comp, props) =>
  renderToStaticMarkup(createElement(Comp, props));

describe("scale", () => {
  it("maps a value onto 0-100 and clamps outside the range", () => {
    expect(scale(28.8, 0, 100)).toBe(28.8);
    expect(scale(5, 0, 20)).toBe(25);
    expect(scale(-3, 0, 10)).toBe(0);
    expect(scale(30, 0, 10)).toBe(100);
    expect(scale(-14, -36, 0)).toBe(61.11);
  });

  it("returns 0 for an empty range instead of dividing by zero", () => {
    expect(scale(4, 4, 4)).toBe(0);
  });
});

describe("evenTicks and valueText", () => {
  it("spaces ticks evenly, five by default", () => {
    expect(evenTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(evenTicks(0, 1, 3)).toEqual([0, 0.5, 1]);
  });

  it("prefers a datum's display over value and unit", () => {
    expect(valueText({ value: 51 }, "%")).toBe("51%");
    expect(valueText({ value: 51, display: "51.00%" }, "%")).toBe("51.00%");
    expect(valueText({ value: 3 })).toBe("3");
  });
});

describe("Bars", () => {
  it("draws one row per datum, scaled to max, with a hidden data table", () => {
    const html = render(Bars, {
      title: "T",
      caption: "C",
      unit: "%",
      max: 100,
      head: ["Benchmark", "Share"],
      data: [
        { label: "A", value: 75.76 },
        { label: "B", value: 51, display: "51.00%", emph: true },
      ],
    });
    expect(html).toContain(
      '<figure class="fig fig-bars"><p class="fig-title">T</p>',
    );
    expect(html).toContain(
      '<span class="fig-fill" style="width:75.76%"></span>',
    );
    expect(html).toContain('<div class="fig-row is-emph">');
    expect(html).toContain('<span class="fig-value">51.00%</span>');
    expect(html).toContain(
      '<div class="fig-sr"><table><thead><tr><th scope="col">Benchmark</th><th scope="col">Share</th></tr></thead>',
    );
    expect(html).toContain('<tr><th scope="row">A</th><td>75.76%</td></tr>');
    expect(html).toContain("<figcaption>C</figcaption>");
  });

  it("scales to the largest value when no max is given, and renders bare", () => {
    const html = render(Bars, {
      data: [
        { label: "x", value: 2 },
        { label: "y", value: 8 },
      ],
    });
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('<th scope="col"></th><th scope="col">Value</th>');
    expect(html).not.toContain("fig-title");
    expect(html).not.toContain("figcaption");
    expect(render(Bars, {})).toContain(
      '<div class="fig-rows" aria-hidden="true"></div>',
    );
  });
});

describe("Dumbbell", () => {
  it("joins two dots per row and anchors the end ticks to the plot edges", () => {
    const html = render(Dumbbell, {
      unit: "%",
      fromLabel: "Before",
      toLabel: "After",
      rows: [{ label: "SWE-bench", from: 20, to: 50 }],
    });
    expect(html).toContain('style="left:20%;width:30%"');
    expect(html).toContain(
      '<span class="fig-dot fig-dot-from" style="left:20%"></span>',
    );
    expect(html).toContain(
      '<span class="fig-dot fig-dot-to" style="left:50%"></span>',
    );
    expect(html).toContain('<span class="fig-value">20% to 50%</span>');
    expect(html).toContain('<span class="is-start" style="left:0%">0%</span>');
    expect(html).toContain('<span style="left:50%">50%</span>');
    expect(html).toContain(
      '<span class="is-end" style="left:100%">100%</span>',
    );
    expect(html).toContain("<td>20%</td><td>50%</td>");
  });

  it("handles a falling pair and explicit ticks", () => {
    const html = render(Dumbbell, {
      min: 0,
      max: 10,
      ticks: [0, 10],
      fromLabel: "a",
      toLabel: "b",
      rows: [{ label: "r", from: 8, to: 2 }],
    });
    expect(html).toContain('style="left:20%;width:60%"');
    expect(html).not.toContain(">5<");
    expect(render(Dumbbell, { fromLabel: "a", toLabel: "b" })).toContain(
      "fig-row-axis",
    );
  });
});

describe("Curve", () => {
  const series = [
    {
      label: "95%",
      end: "36% at 20",
      points: [
        [0, 100],
        [10, 50],
      ],
    },
    {
      label: "99%",
      points: [
        [0, 100],
        [10, 90],
      ],
    },
  ];

  it("draws each series as a stretched polyline with a legend and an end label", () => {
    const html = render(Curve, {
      unit: "%",
      xLabel: "Steps",
      xMax: 10,
      xTicks: [0, 10],
      yTicks: [0, 100],
      series,
    });
    expect(html).toContain(
      '<svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">',
    );
    expect(html).toContain(
      '<polyline class="fig-line fig-series-0" vector-effect="non-scaling-stroke" points="0,0 100,50">',
    );
    expect(html).toContain('points="0,0 100,10"');
    expect(html).toContain('<p class="fig-legend">');
    expect(html).toContain(
      '<span class="fig-end" style="left:100%;bottom:50%">36% at 20</span>',
    );
    expect(html.match(/fig-end/g)).toHaveLength(1);
    expect(html).toContain(
      '<th scope="col">Steps</th><th scope="col">95%</th><th scope="col">99%</th>',
    );
    expect(html).toContain(
      '<tr><th scope="row">10</th><td>50%</td><td>90%</td></tr>',
    );
  });

  it("skips the legend for one series and leaves a missing point blank", () => {
    const html = render(Curve, {
      xLabel: "x",
      xMax: 20,
      series: [
        {
          label: "only",
          end: "e",
          points: [
            [0, 1],
            [20, 2],
          ],
        },
      ],
    });
    expect(html).not.toContain("fig-legend");
    // Only the two plotted samples are rows now; tick 5 carries no sample and
    // is the axis's business, not the table's.
    expect(html).toContain('<tr><th scope="row">0</th><td>1</td></tr>');
    expect(html).toContain('<tr><th scope="row">20</th><td>2</td></tr>');
    expect(html).not.toContain('<tr><th scope="row">5</th>');
    const empty = render(Curve, {
      xLabel: "x",
      xMax: 1,
      series: [{ label: "none", end: "e", points: [] }],
    });
    expect(empty).not.toContain("fig-end");
    expect(render(Curve, { xLabel: "x", xMax: 1 })).toContain("fig-plot");
  });

  it("keeps every plotted sample when the ticks are sparser than the data", () => {
    // The compounding curve plots 21 samples behind 5 ticks; building the table
    // from the ticks dropped 16 of them per series (#3100 review).
    const dense = Array.from({ length: 21 }, (_, i) => [i, 100 - i]);
    const html = render(Curve, {
      xLabel: "Dependent steps",
      xMax: 20,
      xTicks: [0, 5, 10, 15, 20],
      series: [{ label: "dense", end: "e", points: dense }],
    });
    expect(html.match(/<tr><th scope="row">/g)).toHaveLength(21);
    expect(html).toContain('<tr><th scope="row">7</th><td>93</td></tr>');
    expect(html).toContain('<tr><th scope="row">19</th><td>81</td></tr>');
  });

  it("unions the sample positions across series and blanks the gaps", () => {
    const html = render(Curve, {
      xLabel: "x",
      xMax: 3,
      series: [
        {
          label: "a",
          end: "e",
          points: [
            [0, 1],
            [2, 3],
          ],
        },
        {
          label: "b",
          end: "e",
          points: [
            [0, 9],
            [3, 7],
          ],
        },
      ],
    });
    expect(html).toContain(
      '<tr><th scope="row">0</th><td>1</td><td>9</td></tr>',
    );
    expect(html).toContain(
      '<tr><th scope="row">2</th><td>3</td><td></td></tr>',
    );
    expect(html).toContain(
      '<tr><th scope="row">3</th><td></td><td>7</td></tr>',
    );
  });
});

describe("Flow", () => {
  it("numbers the steps, marks the emphasised one, and draws the loop", () => {
    const html = render(Flow, {
      title: "Loop",
      loop: "again",
      steps: [
        { label: "Generate", detail: "A patch" },
        { label: "Verdict", emph: true },
      ],
    });
    expect(html).toContain('<ol class="fig-flow" style="--n:2">');
    expect(html).toContain(
      '<span class="fig-step-n" aria-hidden="true">01</span>',
    );
    expect(html).toContain('<li class="fig-step is-emph">');
    expect(html).toContain('<span class="fig-step-detail">A patch</span>');
    expect(html.match(/fig-step-detail/g)).toHaveLength(1);
    expect(html).toContain(
      '<p class="fig-loop" style="--n:2"><span>again</span></p>',
    );
  });

  it("omits the loop when there is none", () => {
    expect(render(Flow, { steps: [{ label: "a" }] })).not.toContain("fig-loop");
    expect(render(Flow, {})).toContain('style="--n:0"');
  });
});

describe("Ladder", () => {
  it("indexes each rung and names the axis", () => {
    const html = render(Ladder, {
      axis: "Blast radius",
      steps: [{ label: "Prompt", detail: "Reflexion" }, { label: "Code" }],
    });
    expect(html).toContain('<ol class="fig-ladder" style="--n:2">');
    expect(html).toContain('<li class="fig-rung" style="--i:2">');
    expect(html).toContain('<span class="fig-rung-detail">Reflexion</span>');
    expect(html).toContain('<p class="fig-ladder-axis">Blast radius</p>');
    expect(render(Ladder, {})).not.toContain("fig-ladder-axis");
  });
});

describe("Timeline", () => {
  it("places intervals on the clock, hollows ended facts, and drops the marker through each row", () => {
    const html = render(Timeline, {
      start: 0,
      end: 9,
      ticks: [
        { at: 0, label: "Jan" },
        { at: 9, label: "Oct" },
      ],
      marker: { at: 2.25, label: "As of" },
      rows: [
        { label: "Growth", when: "Jan to Mar", from: 3, to: 0, ended: true },
        { label: "Enterprise", when: "Apr on", from: 3, to: 9 },
      ],
    });
    expect(html).toContain(
      '<span class="fig-interval is-ended" style="left:0%;width:33.33%"></span>',
    );
    expect(html).toContain(
      '<span class="fig-interval" style="left:33.33%;width:66.67%"></span>',
    );
    expect(html.match(/class="fig-marker"/g)).toHaveLength(2);
    expect(html).toContain(
      '<span class="fig-marker-label" style="left:25%">As of</span>',
    );
    expect(html).toContain('<span class="is-end" style="left:100%">Oct</span>');
    expect(html).toContain("<td>Jan to Mar</td><td>No longer holds</td>");
    // The marker sits at 2.25 and Enterprise opens at 3, so it has not started.
    expect(html).toContain("<td>Apr on</td><td>Not yet</td>");
    expect(html).toContain('<th scope="col">Status (As of)</th>');
  });

  it("reads each row's status off the marker, not off the ended flag", () => {
    // The ontology figure: a mid-March marker inside a January-to-March row
    // that carries ended: true, and an April-onward row that has not started.
    // Reading the flag reversed both (#3100 review).
    const html = render(Timeline, {
      start: 0,
      end: 9,
      marker: { at: 2.5, label: "As of mid-March" },
      rows: [
        {
          label: "Growth",
          when: "January to March",
          from: 0,
          to: 3,
          ended: true,
        },
        { label: "Enterprise", when: "April onward", from: 3, to: 9 },
      ],
    });
    expect(html).toContain('<th scope="col">Status (As of mid-March)</th>');
    expect(html).toContain("<td>January to March</td><td>Holds</td>");
    expect(html).toContain("<td>April onward</td><td>Not yet</td>");
  });

  it("counts a row that runs to the end of the timeline as holding at the end", () => {
    // "Today" is the end of the clock, so a half-open [from, to) alone would
    // put every current row outside it.
    const html = render(Timeline, {
      start: -36,
      end: 0,
      marker: { at: 0, label: "Today" },
      rows: [
        { label: "Template", when: "Throughout", from: -36, to: 0 },
        {
          label: "Contract",
          when: "Until 14 months ago",
          from: -36,
          to: -14,
          ended: true,
        },
      ],
    });
    expect(html).toContain("<td>Throughout</td><td>Holds</td>");
    expect(html).toContain(
      "<td>Until 14 months ago</td><td>No longer holds</td>",
    );
  });

  it("falls back to the ended flag with no marker and with no interval", () => {
    const html = render(Timeline, {
      start: 0,
      end: 9,
      rows: [
        { label: "Past", when: "Then", from: 0, to: 3, ended: true },
        { label: "Now", when: "Since", from: 3, to: 9 },
      ],
    });
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain("<td>Then</td><td>No longer holds</td>");
    expect(html).toContain("<td>Since</td><td>Holds</td>");

    const noInterval = render(Timeline, {
      start: 0,
      end: 9,
      marker: { at: 2, label: "As of" },
      rows: [{ label: "Undated", when: "Unknown", ended: true }],
    });
    expect(noInterval).toContain("<td>Unknown</td><td>No longer holds</td>");
  });

  it("draws no marker when none is given", () => {
    const html = render(Timeline, {
      start: 0,
      end: 1,
      rows: [{ label: "a", when: "w", from: 0, to: 1 }],
    });
    expect(html).not.toContain("fig-marker");
    expect(render(Timeline, { start: 0, end: 1 })).toContain("fig-row-axis");
  });
});

describe("Schema", () => {
  it("draws a relation between two classes with its constraints", () => {
    const html = render(Schema, {
      edges: [
        {
          from: "Contract",
          rel: "SIGNED_BY",
          to: "LegalEntity",
          notes: ["exactly one"],
        },
        { from: "A", rel: "R", to: "B", notes: [] },
        { from: "C", rel: "S", to: "D" },
      ],
    });
    expect(html).toContain(
      '<li class="fig-edge"><span class="fig-node">Contract</span><span class="fig-rel"><span class="fig-rel-name">SIGNED_BY</span><span class="fig-rel-line" aria-hidden="true"></span><span class="fig-rel-notes"><span>exactly one</span></span></span><span class="fig-node">LegalEntity</span></li>',
    );
    expect(html.match(/fig-rel-notes/g)).toHaveLength(1);
    expect(render(Schema, {})).toContain('<ul class="fig-schema"></ul>');
  });
});

describe("Generations", () => {
  it("stacks real and generated blocks per generation and labels them", () => {
    const html = render(Generations, {
      rows: [
        {
          label: "Replace",
          outcome: "Collapse",
          gens: [
            [1, 0],
            [0, 1],
          ],
        },
        { label: "Accumulate", gens: [[1, 2]] },
      ],
    });
    expect(html).toContain('<ol class="fig-gens" style="--max:1">');
    expect(html).toContain('<ol class="fig-gens" style="--max:3">');
    expect(html).toContain(
      'aria-label="Generation 1: 0 real data, 1 generated data"',
    );
    expect(html).toContain(
      '<span class="fig-stack" aria-hidden="true"><span class="fig-block fig-block-real"></span><span class="fig-block fig-block-synthetic"></span><span class="fig-block fig-block-synthetic"></span></span>',
    );
    expect(html).toContain('<span class="fig-gen-outcome">Collapse</span>');
    expect(html.match(/fig-gen-outcome/g)).toHaveLength(1);
    expect(html).toContain(">Real data</span>");
    const custom = render(Generations, {
      realLabel: "Human",
      syntheticLabel: "Model",
    });
    expect(custom).toContain(">Human</span>");
    expect(custom).toContain(">Model</span>");
  });
});

describe("in a post", () => {
  it("every figure is available to MDX by name", async () => {
    expect(Object.keys(FIGURES).sort()).toEqual([
      "Bars",
      "Curve",
      "Dumbbell",
      "Flow",
      "Generations",
      "Ladder",
      "Schema",
      "Timeline",
    ]);
    const { html } = await renderMdx(
      'Text.\n\n<Bars title="Share" unit="%" data={[{ label: "A", value: 40.9 }]} />\n\n<Flow steps={[{ label: "Localise" }, { label: "Repair" }]} />\n',
    );
    expect(html).toContain('<figure class="fig fig-bars">');
    expect(html).toContain('<span class="fig-value">40.9%</span>');
    expect(html).toContain('<ol class="fig-flow" style="--n:2">');
  });
});
