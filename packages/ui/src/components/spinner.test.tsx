// @vitest-environment jsdom
/**
 * spinner.test.tsx — render tests for the shared Spinner.
 *
 * Covers: role/status a11y, sr-only label, size variants, class merge.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Spinner, spinnerVariants } from "./spinner";

afterEach(cleanup);

describe("spinnerVariants — class map", () => {
  it("defaults to size-4 with animate-spin", () => {
    const cls = spinnerVariants({});
    expect(cls).toContain("size-4");
    expect(cls).toContain("animate-spin");
  });
  it("xs maps to size-3", () => {
    expect(spinnerVariants({ size: "xs" })).toContain("size-3");
  });
  it("xl maps to size-6", () => {
    expect(spinnerVariants({ size: "xl" })).toContain("size-6");
  });
});

describe("Spinner — render", () => {
  it("exposes role=status with a default sr-only label", () => {
    render(<Spinner />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(screen.getByText("Loading")).toHaveClass("sr-only");
  });

  it("uses a custom label", () => {
    render(<Spinner label="Syncing" />);
    expect(screen.getByText("Syncing")).toBeInTheDocument();
  });

  it("merges className on the wrapper", () => {
    render(<Spinner className="text-primary" />);
    expect(screen.getByRole("status").className).toContain("text-primary");
  });
});
