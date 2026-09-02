// @vitest-environment jsdom
/**
 * skeleton.test.tsx — render tests for the Skeleton component.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { Skeleton } from "./skeleton";

afterEach(cleanup);

describe("Skeleton — render", () => {
  it("renders a div", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild?.nodeName).toBe("DIV");
  });

  it("includes animate-pulse class", () => {
    const { container } = render(<Skeleton />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "animate-pulse",
    );
  });

  it("includes rounded-md class", () => {
    const { container } = render(<Skeleton />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "rounded-md",
    );
  });

  it("merges custom className", () => {
    const { container } = render(<Skeleton className="w-full h-4" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("w-full");
    expect(el.className).toContain("h-4");
    expect(el.className).toContain("animate-pulse");
  });
});
