import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Banner } from "../banner.js";

describe("Banner", () => {
  it("renders the Oxagen wordmark, ring glyph, and version", () => {
    const { lastFrame } = render(<Banner version="0.4.0" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◯");
    expect(frame.toLowerCase()).toContain("oxagen");
    expect(frame).toContain("0.4.0");
  });
});
