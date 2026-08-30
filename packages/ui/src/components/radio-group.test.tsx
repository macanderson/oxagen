// @vitest-environment jsdom
/**
 * radio-group.test.tsx — render tests for RadioGroup and Radio.
 *
 * Note: Base UI Radio renders as a <span> with role="radio" and uses
 * aria-disabled + data-disabled (NOT the HTML disabled attribute).
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { RadioGroup, Radio } from "./radio-group";

afterEach(cleanup);

describe("RadioGroup — render", () => {
  it("renders with radiogroup role", () => {
    const { getByRole } = render(
      <RadioGroup>
        <Radio value="a" />
      </RadioGroup>,
    );
    expect(getByRole("radiogroup")).toBeInTheDocument();
  });

  it("renders radio items", () => {
    const { getAllByRole } = render(
      <RadioGroup>
        <Radio value="a" />
        <Radio value="b" />
      </RadioGroup>,
    );
    expect(getAllByRole("radio")).toHaveLength(2);
  });

  it("renders radio with correct initial unchecked state", () => {
    const { getByRole } = render(
      <RadioGroup>
        <Radio value="a" />
      </RadioGroup>,
    );
    expect(getByRole("radio")).toHaveAttribute("aria-checked", "false");
  });

  it("calls onValueChange when radio is clicked", async () => {
    const onChange = vi.fn();
    const { getAllByRole } = render(
      <RadioGroup onValueChange={onChange}>
        <Radio value="a" />
        <Radio value="b" />
      </RadioGroup>,
    );
    const radiosForClick = getAllByRole("radio");
    if (!radiosForClick[1])
      throw new Error("Expected at least 2 radio buttons");
    await userEvent.click(radiosForClick[1]);
    expect(onChange).toHaveBeenCalled();
    // First arg should be the value string
    const firstCall = onChange.mock.calls[0];
    if (!firstCall) throw new Error("Expected onChange to have been called");
    expect(firstCall[0]).toBe("b");
  });

  it("respects defaultValue — second radio is checked", () => {
    const { getAllByRole } = render(
      <RadioGroup defaultValue="b">
        <Radio value="a" />
        <Radio value="b" />
      </RadioGroup>,
    );
    const radios = getAllByRole("radio");
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
  });

  it("disabled Radio has aria-disabled=true", () => {
    const { getByRole } = render(
      <RadioGroup>
        <Radio value="a" disabled />
      </RadioGroup>,
    );
    // Base UI Radio uses aria-disabled not the native disabled attribute
    expect(getByRole("radio")).toHaveAttribute("aria-disabled", "true");
  });

  it("disabled Radio has data-disabled attribute", () => {
    const { getByRole } = render(
      <RadioGroup>
        <Radio value="a" disabled />
      </RadioGroup>,
    );
    expect(getByRole("radio")).toHaveAttribute("data-disabled");
  });

  it("merges custom className on RadioGroup", () => {
    const { container } = render(
      <RadioGroup className="custom-rg">
        <Radio value="x" />
      </RadioGroup>,
    );
    expect(container.firstChild as HTMLElement).toHaveClass("custom-rg");
  });
});
