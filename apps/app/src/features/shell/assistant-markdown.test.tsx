// @vitest-environment jsdom
// A reply renders as markdown, and an `oxagen-chart` fence draws as a chart.
// The chart renderer loads only when a reply holds that fence, so Recharts
// stays out of the shell every signed-in page downloads.
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IntlProvider } from "@/test/intl";
import { AssistantMarkdown } from "./assistant-markdown";

afterEach(cleanup);

const CHART = {
  source: "get_spend, today",
  charts: [
    {
      title: "Runs by agent",
      kind: "bar",
      series: [{ label: "Runs" }],
      rows: [
        { label: "Reviewer", values: [12] },
        { label: "Planner", values: [4] },
      ],
      format: { kind: "number" },
    },
  ],
};

describe("AssistantMarkdown", () => {
  it("draws an oxagen-chart fence as a chart once the renderer loads", async () => {
    render(
      <IntlProvider>
        <AssistantMarkdown>
          {`Here is the chart.\n\n\`\`\`oxagen-chart\n${JSON.stringify(CHART)}\n\`\`\`\n`}
        </AssistantMarkdown>
      </IntlProvider>,
    );
    expect(screen.getByText("Here is the chart.")).toBeInTheDocument();
    expect(
      await screen.findByTestId("assistant-chart", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Runs by agent" })).toBeTruthy();
  });

  it("reaches the chart renderer only through a dynamic import", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "assistant-markdown.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/^import[^;]*from "\.\/assistant-chart";/m);
    expect(source).toContain('import("./assistant-chart")');
  });
});
