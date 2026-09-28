// audit-exempt: read-only — validates and echoes a chart spec the assistant built from figures already in the turn; reads and writes no store. The kernel capability.invoke_* audit covers access.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { CHART_FENCE_LANGUAGE, CHART_LIMITS } from "@oxagen/oxagen/chart-spec";
import { assistantChartRender } from "@oxagen/oxagen/contracts/assistant.chart.render";
import { CapabilityError } from "@oxagen/oxagen/kernel";

/**
 * Returns the chart as a fenced block the assistant pastes into its reply.
 *
 * The contract has already checked the shape. This handler caps the size of
 * the serialized spec, because the reply carries it and the app parses it.
 * A backtick inside a label is written as its JSON escape, so no label can
 * close the fence early.
 */
export const assistantChartRenderHandler: CapabilityHandler<
  typeof assistantChartRender
> = async (input) => {
  const json = JSON.stringify(input).replaceAll("`", "\\u0060");
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > CHART_LIMITS.bytes) {
    throw new CapabilityError(
      "render_chart",
      "invalid_input",
      `The chart spec is ${bytes} bytes and the limit is ${CHART_LIMITS.bytes}. Send fewer rows or fewer charts.`,
    );
  }
  return {
    render: { componentId: "chart", props: input },
    block: `\`\`\`${CHART_FENCE_LANGUAGE}\n${json}\n\`\`\``,
  };
};
