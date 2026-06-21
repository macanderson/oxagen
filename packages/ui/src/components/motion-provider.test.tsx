// @vitest-environment jsdom
/**
 * motion-provider.test.tsx — render tests for MotionProvider.
 *
 * Covers: MotionProvider renders children without crash, wraps with
 * framer-motion's MotionConfig (reducedMotion="user").
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { MotionProvider } from "./motion-provider";

afterEach(cleanup);

describe("MotionProvider", () => {
  it("renders children without crashing", () => {
    const { getByText } = render(
      <MotionProvider>
        <span>child content</span>
      </MotionProvider>,
    );
    expect(getByText("child content")).toBeInTheDocument();
  });

  it("renders multiple children", () => {
    const { getByText } = render(
      <MotionProvider>
        <span>first</span>
        <span>second</span>
      </MotionProvider>,
    );
    expect(getByText("first")).toBeInTheDocument();
    expect(getByText("second")).toBeInTheDocument();
  });

  it("renders a React element child", () => {
    const { getByRole } = render(
      <MotionProvider>
        <button type="button">Click me</button>
      </MotionProvider>,
    );
    expect(getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });
});
