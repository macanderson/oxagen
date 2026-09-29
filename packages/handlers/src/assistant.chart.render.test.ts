import { describe, expect, it } from "vitest";
import { CHART_LIMITS } from "@oxagen/oxagen/chart-spec";
import { assistantChartRender } from "@oxagen/oxagen/contracts/assistant.chart.render";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { assistantChartRenderHandler } from "./assistant.chart.render";
import { TEST_CTX } from "./test-utils/fixtures";

const spec = (rowCount: number, label = "Day") =>
  assistantChartRender.input.parse({
    source: "get_spend, September",
    charts: [
      {
        title: "Spend by day",
        kind: "bar",
        series: [{ label: "Spend" }],
        rows: Array.from({ length: rowCount }, (_, i) => ({
          label: `${label} ${i}`,
          values: [i === 1 ? null : i],
        })),
        format: { kind: "number" },
      },
    ],
  });

describe("render_chart handler", () => {
  it("returns the spec and a fenced block that parses back to it", async () => {
    const input = spec(3);
    const out = await assistantChartRenderHandler(input, TEST_CTX);
    expect(out.render).toEqual({ componentId: "chart", props: input });
    const match = /^```oxagen-chart\n([\s\S]*)\n```$/.exec(out.block);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(input);
  });

  it("escapes a backtick so a label cannot close the fence", async () => {
    const input = spec(2, "```injected");
    const out = await assistantChartRenderHandler(input, TEST_CTX);
    const body = out.block.slice("```oxagen-chart\n".length, -"\n```".length);
    expect(body).not.toContain("`");
    expect(JSON.parse(body).charts[0].rows[0].label).toBe("```injected 0");
  });

  it("refuses a spec over the byte limit (negative)", async () => {
    const one = spec(CHART_LIMITS.rows, "x".repeat(CHART_LIMITS.labelChars - 4));
    const input = { ...one, charts: [...one.charts, ...one.charts] };
    expect(JSON.stringify(input).length).toBeGreaterThan(CHART_LIMITS.bytes);
    await expect(assistantChartRenderHandler(input, TEST_CTX)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === "invalid_input" &&
        error.capability === "render_chart",
    );
  });
});
