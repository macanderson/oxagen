// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { DeltaChip } from "./delta-chip";

afterEach(cleanup);

describe("DeltaChip", () => {
  it("renders green tone and data-direction=up for an upward move with goodDirection=up", () => {
    render(<DeltaChip current={120} previous={100} goodDirection="up" />);

    const chip = screen.getByTestId("delta-chip");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("data-direction", "up");
    expect(chip.className).toContain("text-emerald-600");
    expect(chip).toHaveTextContent("20%");
  });

  it("renders the opposite (rose) tone for a downward move with goodDirection=up", () => {
    render(<DeltaChip current={80} previous={100} goodDirection="up" />);

    const chip = screen.getByTestId("delta-chip");
    expect(chip).toHaveAttribute("data-direction", "down");
    expect(chip.className).toContain("text-rose-600");
  });

  it("flips tone when goodDirection=down: a downward move is good (green)", () => {
    render(<DeltaChip current={80} previous={100} goodDirection="down" />);

    const chip = screen.getByTestId("delta-chip");
    expect(chip).toHaveAttribute("data-direction", "down");
    expect(chip.className).toContain("text-emerald-600");
  });

  it("flips tone when goodDirection=down: an upward move is bad (rose)", () => {
    render(<DeltaChip current={120} previous={100} goodDirection="down" />);

    const chip = screen.getByTestId("delta-chip");
    expect(chip).toHaveAttribute("data-direction", "up");
    expect(chip.className).toContain("text-rose-600");
  });

  it('renders "new" when previous is 0 and current is greater than 0', () => {
    render(<DeltaChip current={5} previous={0} />);

    const chip = screen.getByTestId("delta-chip");
    expect(chip).toHaveTextContent("new");
    expect(chip).toHaveAttribute("data-direction", "up");
    expect(chip.className).toContain("text-muted-foreground");
  });

  it('renders "0%" and data-direction=flat when current equals previous', () => {
    render(<DeltaChip current={50} previous={50} />);

    const chip = screen.getByTestId("delta-chip");
    expect(chip).toHaveTextContent("0%");
    expect(chip).toHaveAttribute("data-direction", "flat");
    expect(chip.className).toContain("text-muted-foreground");
  });

  it("renders the label prop as trailing context", () => {
    render(<DeltaChip current={120} previous={100} label="vs yesterday" />);

    expect(screen.getByText("vs yesterday")).toBeInTheDocument();
  });
});
