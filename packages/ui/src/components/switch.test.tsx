// @vitest-environment jsdom
/**
 * switch.test.tsx — render tests for the Switch component.
 *
 * Note: Base UI Switch renders as a <span> with role="switch" and uses
 * aria-disabled + data-disabled (NOT the HTML disabled attribute).
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { Switch } from "./switch";

afterEach(cleanup);

describe("Switch — render", () => {
  it("renders with switch role", () => {
    const { getByRole } = render(<Switch />);
    expect(getByRole("switch")).toBeInTheDocument();
  });

  it("is unchecked by default (aria-checked=false)", () => {
    const { getByRole } = render(<Switch />);
    expect(getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("is disabled when disabled prop set (aria-disabled)", () => {
    const { getByRole } = render(<Switch disabled />);
    // Base UI Switch uses aria-disabled not the native disabled attribute
    expect(getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  });

  it("has data-disabled attribute when disabled", () => {
    const { getByRole } = render(<Switch disabled />);
    expect(getByRole("switch")).toHaveAttribute("data-disabled");
  });

  it("uses the --control-track-bg token in the unchecked state", () => {
    const { getByRole } = render(<Switch />);
    expect(getByRole("switch").className).toContain("bg-control-track-bg");
  });

  it("calls onCheckedChange when toggled (checked true)", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(<Switch onCheckedChange={onChange} />);
    await userEvent.click(getByRole("switch"));
    // onCheckedChange is called; may receive extra event data so just verify it was called
    expect(onChange).toHaveBeenCalled();
    const firstCall = onChange.mock.calls[0];
    if (!firstCall) throw new Error("Expected onChange to have been called");
    expect(firstCall[0]).toBe(true);
  });

  it("reflects controlled checked=true state (aria-checked=true)", () => {
    const { getByRole } = render(<Switch checked onCheckedChange={vi.fn()} />);
    expect(getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("merges custom className", () => {
    const { getByRole } = render(<Switch className="my-switch" />);
    expect(getByRole("switch").className).toContain("my-switch");
  });
});
