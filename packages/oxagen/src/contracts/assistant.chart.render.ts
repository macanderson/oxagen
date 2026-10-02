/**
 * `render_chart`: the in-app assistant draws a chart, or a small dashboard of
 * stat tiles and charts, in its reply.
 *
 * The assistant already reads spend, runs, and agents through its tools. This
 * capability turns figures it has read into a picture a person can scan. It
 * reads no store and writes none: the handler checks the shape and size, then
 * returns the spec as a fenced `oxagen-chart` block. The assistant pastes that
 * block into its reply, and the app draws it with the same chart kit the Spend
 * page uses, with a table of every value under it.
 *
 * The figures are the model's to supply, so the spec carries a required
 * `source` naming the tool results they came from, and the app prints it under
 * the chart. A value the record does not hold is `null` and draws as a gap,
 * never as zero.
 *
 * Agent surface only: a chart is part of an assistant reply, not an API or MCP
 * action. Not a governed action: it acts on no agent, grants nothing, and
 * spends nothing, so `noBillingGate: true`. The roles are the assistant's
 * readers', because anyone who may read the figures may see them drawn.
 * Saving a dashboard is a separate change (#4177).
 */
import { z } from "zod";
import {
  CHART_FORMAT_KINDS,
  CHART_KINDS,
  CHART_LIMITS,
} from "../chart-spec";
import { registerCapability } from "../registry";

const text = (max: number) => z.string().trim().min(1).max(max);

const format = z.object({
  kind: z
    .enum(CHART_FORMAT_KINDS)
    .describe(
      "number; currency (a decimal amount); percent (a 0..1 ratio); duration (milliseconds)",
    ),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .describe("ISO 4217 code such as USD. Required when kind is currency"),
});

const value = z
  .number()
  .finite()
  .nullable()
  .describe("null when the record holds no value; it draws as a gap");

const chartSpec = z.object({
  title: z
    .string()
    .trim()
    .max(CHART_LIMITS.titleChars)
    .optional()
    .describe("Dashboard title, when there is more than one chart or tile"),
  source: text(CHART_LIMITS.sourceChars).describe(
    "The tool results the figures came from, such as `get_spend, 1-28 September`",
  ),
  tiles: z
    .array(
      z.object({
        label: text(CHART_LIMITS.labelChars),
        value,
        format: format.optional(),
        note: z.string().trim().max(CHART_LIMITS.noteChars).optional(),
      }),
    )
    .max(CHART_LIMITS.tiles)
    .default([])
    .describe("Stat tiles: one headline number each"),
  charts: z
    .array(
      z.object({
        title: text(CHART_LIMITS.titleChars),
        kind: z
          .enum(CHART_KINDS)
          .describe(
            "line or area for a value over time; bar to compare items; stacked_bar for parts of a whole",
          ),
        series: z
          .array(z.object({ label: text(CHART_LIMITS.labelChars) }))
          .min(1)
          .max(CHART_LIMITS.series),
        rows: z
          .array(
            z.object({
              label: text(CHART_LIMITS.labelChars).describe(
                "The x-axis category: a date, an agent, a tool",
              ),
              values: z
                .array(value)
                .min(1)
                .max(CHART_LIMITS.series)
                .describe("One value per series, in series order"),
            }),
          )
          .min(1)
          .max(CHART_LIMITS.rows),
        format,
        unit: z
          .string()
          .trim()
          .max(CHART_LIMITS.unitChars)
          .optional()
          .describe("What a plain number counts, such as runs or tokens"),
      }),
    )
    .max(CHART_LIMITS.charts)
    .default([]),
});

export const assistantChartRender = registerCapability({
  name: "render_chart",
  domain: "assistant",
  description:
    "Draw a chart, graph, or plot, or a small dashboard of stat tiles and charts, in your reply. " +
    "Use it when a trend over time, a ranking, or a part-of-a-whole comparison reads faster as a picture. " +
    "Kinds: line, area, bar, stacked_bar. Every figure must come from a tool result in this conversation: " +
    "name those results in `source`, and send null for a value the record does not hold. Never invent or estimate a figure. " +
    "Returns `block`: paste it into your reply unchanged where the chart belongs.",
  mode: "sync",
  surfaces: ["agent"] as const,
  inAppAssistant: true,
  layers: ["schema", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  // Validates and echoes the spec. Reads and writes no store.
  mutates: false,
  noBillingGate: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: chartSpec.superRefine((spec, ctx) => {
    if (spec.tiles.length === 0 && spec.charts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["charts"],
        message: "Send at least one chart or one tile.",
      });
    }
    spec.tiles.forEach((tile, t) => {
      if (tile.format?.kind === "currency" && !tile.format.currency) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tiles", t, "format", "currency"],
          message: "A currency format names its ISO 4217 code.",
        });
      }
    });
    spec.charts.forEach((chart, c) => {
      if (chart.format.kind === "currency" && !chart.format.currency) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["charts", c, "format", "currency"],
          message: "A currency format names its ISO 4217 code.",
        });
      }
      chart.rows.forEach((row, r) => {
        if (row.values.length !== chart.series.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["charts", c, "rows", r, "values"],
            message: `The row has ${row.values.length} values and the chart has ${chart.series.length} series. Send one value per series.`,
          });
        }
      });
    });
  }),
  output: z.object({
    render: z.object({
      componentId: z.literal("chart"),
      props: chartSpec,
    }),
    block: z
      .string()
      .describe("A fenced oxagen-chart block. Paste it into the reply unchanged"),
  }),
});

export type AssistantChartRenderInput = z.output<
  typeof assistantChartRender.input
>;
export type AssistantChartRenderOutput = z.output<
  typeof assistantChartRender.output
>;
