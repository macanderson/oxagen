// @vitest-environment jsdom
/**
 * segmented-control.test.tsx — render tests for SegmentedControl and SegmentedControlItem.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";

afterEach(cleanup);

describe("SegmentedControl — render", () => {
  it("renders all items", () => {
    const { getByRole } = render(
      <SegmentedControl>
        <SegmentedControlItem value="small">Small</SegmentedControlItem>
        <SegmentedControlItem value="medium">Medium</SegmentedControlItem>
        <SegmentedControlItem value="large">Large</SegmentedControlItem>
      </SegmentedControl>,
    );
    expect(getByRole("button", { name: "Small" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Medium" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Large" })).toBeInTheDocument();
  });

  it("calls onValueChange when an item is clicked", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <SegmentedControl onValueChange={onChange}>
        <SegmentedControlItem value="small">Small</SegmentedControlItem>
        <SegmentedControlItem value="medium">Medium</SegmentedControlItem>
      </SegmentedControl>,
    );
    await userEvent.click(getByRole("button", { name: "Medium" }));
    expect(onChange).toHaveBeenCalledWith("medium");
  });

  it("selected item has data-pressed attribute", () => {
    const { getByRole } = render(
      <SegmentedControl value="large">
        <SegmentedControlItem value="small">Small</SegmentedControlItem>
        <SegmentedControlItem value="large">Large</SegmentedControlItem>
      </SegmentedControl>,
    );
    const largeBtn = getByRole("button", { name: "Large" });
    expect(largeBtn.dataset.pressed).toBeDefined();
  });

  it("merges custom className on root", () => {
    const { container } = render(
      <SegmentedControl className="custom-sc">
        <SegmentedControlItem value="x">X</SegmentedControlItem>
      </SegmentedControl>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "custom-sc",
    );
  });

  it("disabled item cannot be clicked", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <SegmentedControl onValueChange={onChange}>
        <SegmentedControlItem value="a">A</SegmentedControlItem>
        <SegmentedControlItem value="b" disabled>
          B
        </SegmentedControlItem>
      </SegmentedControl>,
    );
    await userEvent.click(getByRole("button", { name: "B" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
