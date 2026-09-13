// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithIntl } from "./testing/render-with-intl";
import { ToolCell } from "./tool-cell";

afterEach(() => {
  cleanup();
});

describe("ToolCell", () => {
  it("leads with the label and follows with the API name and version", () => {
    renderWithIntl(<ToolCell tool="github__merge_pull_request@2.3.0" />);
    const cell = screen.getByTestId("tool-cell");
    expect(cell).toHaveAttribute("data-category", "vcs");
    expect(cell).toHaveTextContent(
      "Source controlMerge pull requestgithub__merge_pull_request@2.3.0",
    );
    expect(cell).toHaveAttribute(
      "title",
      "github__merge_pull_request@2.3.0 — Merge pull request · Source control",
    );
  });

  it("swaps the order when the viewer picked API names", () => {
    renderWithIntl(
      <ToolCell tool="stripe__create_payment" names="api" sub="3 calls" />,
    );
    const lines = screen.getByTestId("tool-cell").querySelectorAll(".truncate");
    expect(lines[0]).toHaveTextContent("stripe__create_payment");
    expect(lines[1]).toHaveTextContent("Create payment · 3 calls");
  });

  it("prefers the registry's label and category over the derived ones", () => {
    renderWithIntl(
      <ToolCell
        tool="stripe__create_payment@1.0.0"
        label="Charge a customer"
        category="finance"
        size="sm"
      />,
    );
    const cell = screen.getByTestId("tool-cell");
    expect(cell).toHaveAttribute("data-category", "finance");
    expect(cell).toHaveTextContent("Charge a customer");
    expect(screen.getByText("Financial control")).toHaveClass("sr-only");
  });
});
