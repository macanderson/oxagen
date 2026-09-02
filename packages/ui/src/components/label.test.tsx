// @vitest-environment jsdom
/**
 * label.test.tsx — render tests for the Label component.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { Label } from "./label";

afterEach(cleanup);

describe("Label — render", () => {
  it("renders a label element", () => {
    const { getByText } = render(<Label>Name</Label>);
    expect(getByText("Name").tagName.toLowerCase()).toBe("label");
  });

  it("associates with an input via htmlFor", () => {
    const { getByText } = render(
      <>
        <Label htmlFor="email-input">Email</Label>
        <input id="email-input" />
      </>,
    );
    expect(getByText("Email")).toHaveAttribute("for", "email-input");
  });

  it("includes text-sm font-medium classes", () => {
    const { getByText } = render(<Label>Label text</Label>);
    const el = getByText("Label text");
    expect(el.className).toContain("text-sm");
    expect(el.className).toContain("font-medium");
  });

  it("merges custom className", () => {
    const { getByText } = render(
      <Label className="custom-label">Custom</Label>,
    );
    expect(getByText("Custom").className).toContain("custom-label");
  });
});
