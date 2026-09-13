// @vitest-environment jsdom
/**
 * field-fill-transition.test.tsx — render tests for FieldFillTransition.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { FieldFillTransition } from "./field-fill-transition";

afterEach(cleanup);

describe("FieldFillTransition — render", () => {
  it("renders children", () => {
    const { getByRole } = render(
      <FieldFillTransition active={false}>
        <input aria-label="test-input" />
      </FieldFillTransition>,
    );
    expect(getByRole("textbox", { name: "test-input" })).toBeInTheDocument();
  });

  it("inactive: no data-fill-active attribute", () => {
    const { container } = render(
      <FieldFillTransition active={false}>
        <span>content</span>
      </FieldFillTransition>,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.dataset.fillActive).toBeUndefined();
  });

  it("active: sets data-fill-active=true attribute", () => {
    const { container } = render(
      <FieldFillTransition active={true}>
        <span>content</span>
      </FieldFillTransition>,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.dataset.fillActive).toBe("true");
  });

  it("active: injects <style> tag with keyframe animation", () => {
    const { container } = render(
      <FieldFillTransition active={true}>
        <span>content</span>
      </FieldFillTransition>,
    );
    const style = container.querySelector("style");
    expect(style).toBeInTheDocument();
    expect(style?.textContent).toContain("@keyframes field-fill-glow");
  });

  it("inactive: no <style> tag injected", () => {
    const { container } = render(
      <FieldFillTransition active={false}>
        <span>content</span>
      </FieldFillTransition>,
    );
    expect(container.querySelector("style")).toBeNull();
  });

  it("active: applies inline box-shadow style", () => {
    const { container } = render(
      <FieldFillTransition active={true}>
        <span>content</span>
      </FieldFillTransition>,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.boxShadow).not.toBe("");
  });

  it("inactive: no inline box-shadow", () => {
    const { container } = render(
      <FieldFillTransition active={false}>
        <span>content</span>
      </FieldFillTransition>,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.boxShadow).toBe("");
  });

  it("merges custom className", () => {
    const { container } = render(
      <FieldFillTransition active={false} className="custom-wrap">
        <span>content</span>
      </FieldFillTransition>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "custom-wrap",
    );
  });
});
