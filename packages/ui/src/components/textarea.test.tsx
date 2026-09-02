// @vitest-environment jsdom
/**
 * textarea.test.tsx — render tests for the Textarea component.
 *
 * Covers: renders as <textarea>, size → class, placeholder, disabled, user typing.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach } from "vitest";
import { Textarea, textareaVariants } from "./textarea";

afterEach(cleanup);

// ── Variant map ──────────────────────────────────────────────────────────────

describe("textareaVariants — class map", () => {
  it("includes rounded-md base class", () => {
    expect(textareaVariants({})).toContain("rounded-md");
  });
  it("sm size includes min-h-[52px]", () => {
    expect(textareaVariants({ size: "sm" })).toContain("min-h-[52px]");
  });
  it("default size includes min-h-[60px]", () => {
    expect(textareaVariants({ size: "default" })).toContain("min-h-[60px]");
  });
  it("lg size includes min-h-[72px]", () => {
    expect(textareaVariants({ size: "lg" })).toContain("min-h-[72px]");
  });
});

// ── Render tests ─────────────────────────────────────────────────────────────

describe("Textarea — render", () => {
  it("renders a textarea element", () => {
    const { container } = render(<Textarea />);
    expect(container.querySelector("textarea")).toBeInTheDocument();
  });

  it("renders with placeholder", () => {
    const { getByPlaceholderText } = render(
      <Textarea placeholder="Type here" />,
    );
    expect(getByPlaceholderText("Type here")).toBeInTheDocument();
  });

  it("is disabled when disabled prop set", () => {
    const { container } = render(<Textarea disabled />);
    expect(container.querySelector("textarea")).toBeDisabled();
  });

  it("applies size class", () => {
    const { container } = render(<Textarea size="lg" />);
    expect(container.querySelector("textarea")?.className).toContain(
      "min-h-[72px]",
    );
  });

  it("merges custom className", () => {
    const { container } = render(<Textarea className="my-textarea" />);
    expect(container.querySelector("textarea")?.className).toContain(
      "my-textarea",
    );
  });

  it("accepts user input", async () => {
    const { container } = render(<Textarea />);
    const ta = container.querySelector("textarea")!;
    await userEvent.type(ta, "Hello world");
    expect(ta).toHaveValue("Hello world");
  });

  it("respects controlled value", () => {
    const { container } = render(<Textarea readOnly value="preset" />);
    expect(container.querySelector("textarea")).toHaveValue("preset");
  });
});
