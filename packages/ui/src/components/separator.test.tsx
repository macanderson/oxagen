// @vitest-environment jsdom
/**
 * separator.test.tsx — render tests for the Separator component.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { Separator } from "./separator";

afterEach(cleanup);

describe("Separator — render", () => {
  it("renders with separator role", () => {
    const { getByRole } = render(<Separator />);
    expect(getByRole("separator")).toBeInTheDocument();
  });

  it("horizontal orientation includes h-px w-full classes", () => {
    const { getByRole } = render(<Separator orientation="horizontal" />);
    const el = getByRole("separator");
    expect(el.className).toContain("h-px");
    expect(el.className).toContain("w-full");
  });

  it("vertical orientation includes h-full w-px classes", () => {
    const { getByRole } = render(<Separator orientation="vertical" />);
    const el = getByRole("separator");
    expect(el.className).toContain("h-full");
    expect(el.className).toContain("w-px");
  });

  it("defaults to horizontal orientation", () => {
    const { getByRole } = render(<Separator />);
    expect(getByRole("separator").className).toContain("h-px");
  });

  it("includes bg-border class", () => {
    const { getByRole } = render(<Separator />);
    expect(getByRole("separator").className).toContain("bg-border");
  });

  it("merges custom className", () => {
    const { getByRole } = render(<Separator className="my-sep" />);
    expect(getByRole("separator").className).toContain("my-sep");
  });
});
