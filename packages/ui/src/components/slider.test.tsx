// @vitest-environment jsdom
/**
 * slider.test.tsx — render tests for the Slider component.
 *
 * Note: Base UI Slider thumb role="slider". Disabled state uses data-disabled
 * attribute on the control wrapper. The aria-disabled may not be on the thumb
 * element itself — using data-disabled is the correct check.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { Slider } from "./slider";

afterEach(cleanup);

describe("Slider — render", () => {
  it("renders a slider role", () => {
    const { getByRole } = render(
      <Slider defaultValue={50} min={0} max={100} />,
    );
    expect(getByRole("slider")).toBeInTheDocument();
  });

  it("renders with aria-valuenow reflecting defaultValue", () => {
    const { getByRole } = render(
      <Slider defaultValue={30} min={0} max={100} />,
    );
    expect(getByRole("slider")).toHaveAttribute("aria-valuenow", "30");
  });

  it("slider has aria-valuenow attribute", () => {
    const { getByRole } = render(
      <Slider defaultValue={50} min={0} max={100} />,
    );
    expect(getByRole("slider")).toHaveAttribute("aria-valuenow");
  });

  it("disabled slider — control wrapper has data-disabled attribute", () => {
    const { container } = render(<Slider defaultValue={50} disabled />);
    // The control div wrapping the slider receives data-disabled
    const disabledEl = container.querySelector("[data-disabled]");
    expect(disabledEl).toBeInTheDocument();
  });

  it("merges custom className on root", () => {
    const { container } = render(
      <Slider defaultValue={0} className="custom-slider" />,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "custom-slider",
    );
  });
});
