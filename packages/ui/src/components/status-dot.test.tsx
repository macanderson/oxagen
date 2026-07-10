// @vitest-environment jsdom
/**
 * status-dot.test.tsx — render tests for the shared StatusDot.
 *
 * Covers: status → token color, sizes, pulse ring, label/srLabel.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);
import { StatusDot, statusDotVariants } from "./status-dot";

describe("statusDotVariants — class map", () => {
  it("success maps to text-success", () => {
    expect(statusDotVariants({ status: "success" })).toContain("text-success");
  });
  it("error maps to text-error", () => {
    expect(statusDotVariants({ status: "error" })).toContain("text-error");
  });
  it("neutral is the default status", () => {
    expect(statusDotVariants({})).toContain("text-muted-foreground");
  });
  it("size lg maps to size-2.5", () => {
    expect(statusDotVariants({ size: "lg" })).toContain("size-2.5");
  });
});

describe("StatusDot — render", () => {
  it("renders a visible label beside the dot", () => {
    render(<StatusDot status="success" label="Healthy" />);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("renders an sr-only status name when only srLabel is given", () => {
    render(<StatusDot status="error" srLabel="Failed" />);
    expect(screen.getByText("Failed")).toHaveClass("sr-only");
  });

  it("pulse renders the expanding ping ring", () => {
    const { container } = render(<StatusDot status="info" pulse />);
    expect(container.querySelector(".animate-ping")).not.toBeNull();
  });

  it("no ping ring at rest", () => {
    const { container } = render(<StatusDot status="info" />);
    expect(container.querySelector(".animate-ping")).toBeNull();
  });
});
