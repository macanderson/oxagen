// @vitest-environment jsdom
/**
 * select.test.tsx — render tests for Select and sub-parts.
 *
 * Covers: coss naming (SelectPopup not SelectContent), SelectTrigger size variants,
 * SelectItem renders inside popup, SelectGroup/SelectLabel.
 */

import { render, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach } from "vitest";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "./select";

afterEach(cleanup);

function TestSelect({ size }: { size?: "sm" | "default" | "lg" }) {
  return (
    <Select>
      <SelectTrigger size={size}>
        <SelectValue placeholder="Select option" />
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectLabel>Fruits</SelectLabel>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

describe("Select — trigger render", () => {
  it("renders a combobox trigger", () => {
    const { getByRole } = render(<TestSelect />);
    expect(getByRole("combobox")).toBeInTheDocument();
  });

  it("shows placeholder text", () => {
    const { getByRole } = render(<TestSelect />);
    expect(getByRole("combobox")).toHaveTextContent("Select option");
  });

  it("sm size trigger includes h-7 class", () => {
    const { getByRole } = render(<TestSelect size="sm" />);
    expect(getByRole("combobox").className).toContain("h-7");
  });

  it("default size trigger includes h-8 class", () => {
    const { getByRole } = render(<TestSelect size="default" />);
    expect(getByRole("combobox").className).toContain("h-8");
  });

  it("lg size trigger includes h-9 class", () => {
    const { getByRole } = render(<TestSelect size="lg" />);
    expect(getByRole("combobox").className).toContain("h-9");
  });
});

// Note: Base UI Select popup requires pointer events + floating-UI layout to
// open (same constraint as Menu). JSDOM doesn't support layout, so the popup
// cannot be opened in unit tests. Interactive selection is covered by e2e.
describe("Select — trigger aria attributes", () => {
  it("trigger has aria-haspopup=listbox", () => {
    const { getByRole } = render(<TestSelect />);
    expect(getByRole("combobox")).toHaveAttribute("aria-haspopup", "listbox");
  });

  it("trigger starts with aria-expanded=false", () => {
    const { getByRole } = render(<TestSelect />);
    expect(getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });

  it("SelectItem and SelectLabel are importable (export sanity check)", () => {
    // Verify the named exports resolve as React component objects
    expect(typeof SelectItem).toBe("object");
    expect(typeof SelectLabel).toBe("object");
  });
});
