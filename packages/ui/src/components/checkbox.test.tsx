// @vitest-environment jsdom
/**
 * checkbox.test.tsx — Checkbox renders the Base UI checkbox, drives state via
 * onCheckedChange, and styles every part through the --control-* token
 * utilities (no raw palette colors). Proves --control-indicator is wired.
 */
import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { Checkbox } from "./checkbox";

afterEach(cleanup);

describe("Checkbox", () => {
  it("renders an accessible checkbox", () => {
    const { getByRole } = render(<Checkbox aria-label="Accept terms" />);
    expect(getByRole("checkbox", { name: "Accept terms" })).toBeInTheDocument();
  });

  it("styles the track and border with --control-* tokens (no raw palette)", () => {
    const { getByRole } = render(<Checkbox aria-label="t" />);
    const cls = getByRole("checkbox", { name: "t" }).className;
    expect(cls).toContain("border-control-border");
    expect(cls).toContain("bg-control-track-bg");
    expect(cls).toContain("data-[checked]:bg-control-track-bg-checked");
    expect(cls).toContain("focus-visible:ring-control-ring");
  });

  it("renders the indicator with the --control-indicator token when checked", () => {
    const { container, getByRole } = render(
      <Checkbox defaultChecked aria-label="c" />,
    );
    expect(getByRole("checkbox", { name: "c" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const indicator = container.querySelector(".text-control-indicator");
    expect(indicator).not.toBeNull();
    // The check glyph is present (not the indeterminate minus).
    expect(container.querySelector(".coss-check")).not.toBeNull();
  });

  it("fires onCheckedChange with the next boolean when toggled", async () => {
    const onCheckedChange = vi.fn();
    const { getByRole } = render(
      <Checkbox aria-label="toggle" onCheckedChange={onCheckedChange} />,
    );
    await userEvent.click(getByRole("checkbox", { name: "toggle" }));
    expect(onCheckedChange).toHaveBeenCalledOnce();
    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("does not toggle when disabled", async () => {
    const onCheckedChange = vi.fn();
    const { getByRole } = render(
      <Checkbox aria-label="d" disabled onCheckedChange={onCheckedChange} />,
    );
    await userEvent.click(getByRole("checkbox", { name: "d" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
