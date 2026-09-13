// @vitest-environment jsdom
/**
 * confidence-meter.test.tsx — render tests for ConfidenceMeter.
 *
 * Covers: percentage text, band labels (High/Medium/Low), role="meter"
 * aria attributes, and value clamping for out-of-range inputs.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ConfidenceMeter } from "./confidence-meter";

afterEach(cleanup);

describe("ConfidenceMeter", () => {
  it("renders the confidence as a percentage (0.9 → 90%)", () => {
    render(<ConfidenceMeter confidence={0.9} />);
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("renders 'High' band label for confidence ≥ 0.8", () => {
    render(<ConfidenceMeter confidence={0.8} />);
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("renders 'Medium' band label for confidence between 0.5 and 0.8", () => {
    render(<ConfidenceMeter confidence={0.65} />);
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByText("65%")).toBeInTheDocument();
  });

  it("renders 'Low' band label for confidence < 0.5", () => {
    render(<ConfidenceMeter confidence={0.3} />);
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
  });

  it("renders a role='meter' element with correct aria attributes", () => {
    render(<ConfidenceMeter confidence={0.75} />);
    const meter = screen.getByRole("meter");
    expect(meter).toBeInTheDocument();
    expect(meter).toHaveAttribute("aria-valuenow", "75");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
  });

  it("clamps values above 1 to 100%", () => {
    render(<ConfidenceMeter confidence={1.5} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "100");
  });

  it("clamps values below 0 to 0%", () => {
    render(<ConfidenceMeter confidence={-0.2} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "0");
  });

  it("renders exactly at the 0.8 boundary as 'High'", () => {
    render(<ConfidenceMeter confidence={0.8} />);
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("renders just below 0.5 as 'Low'", () => {
    render(<ConfidenceMeter confidence={0.49} />);
    expect(screen.getByText("Low")).toBeInTheDocument();
  });
});
