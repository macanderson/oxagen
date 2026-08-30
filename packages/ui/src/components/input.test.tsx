// @vitest-environment jsdom
/**
 * input.test.tsx — render tests for the Input component.
 *
 * Covers: renders as <input>, size → class, placeholder, type, disabled,
 * user typing, custom className.
 */

import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach } from "vitest";
import { Input, inputVariants } from "./input";

afterEach(cleanup);

// ── Variant map ──────────────────────────────────────────────────────────────

describe("inputVariants — class map", () => {
  it("includes rounded-md base class", () => {
    expect(inputVariants({})).toContain("rounded-md");
  });
  it("sm size includes h-7", () => {
    expect(inputVariants({ size: "sm" })).toContain("h-7");
  });
  it("default size includes h-8", () => {
    expect(inputVariants({ size: "default" })).toContain("h-8");
  });
  it("lg size includes h-9", () => {
    expect(inputVariants({ size: "lg" })).toContain("h-9");
  });
});

// ── Render tests ─────────────────────────────────────────────────────────────

describe("Input — render", () => {
  it("renders an input element", () => {
    const { container } = render(<Input />);
    expect(container.querySelector("input")).toBeInTheDocument();
  });

  it("renders with placeholder", () => {
    const { getByPlaceholderText } = render(
      <Input placeholder="Enter email" />,
    );
    expect(getByPlaceholderText("Enter email")).toBeInTheDocument();
  });

  it("renders with type attribute", () => {
    const { container } = render(<Input type="email" />);
    expect(container.querySelector("input")).toHaveAttribute("type", "email");
  });

  it("is disabled when disabled prop set", () => {
    const { container } = render(<Input disabled />);
    expect(container.querySelector("input")).toBeDisabled();
  });

  it("applies size class", () => {
    const { container } = render(<Input size="lg" />);
    expect(container.querySelector("input")?.className).toContain("h-9");
  });

  it("merges custom className", () => {
    const { container } = render(<Input className="custom-input" />);
    expect(container.querySelector("input")?.className).toContain(
      "custom-input",
    );
  });

  it("accepts user input", async () => {
    const { container } = render(<Input />);
    const input = container.querySelector("input")!;
    await userEvent.type(input, "hello");
    expect(input).toHaveValue("hello");
  });

  it("respects controlled value", () => {
    const { container } = render(<Input readOnly value="controlled" />);
    expect(container.querySelector("input")).toHaveValue("controlled");
  });
});
