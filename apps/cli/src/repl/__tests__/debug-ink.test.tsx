import { describe, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import React from "react";

describe("ink ansi debug", () => {
  it("shows bold amber ansi codes", () => {
    const r1 = render(React.createElement(Text, { color: '#FBBF24', bold: true }, 'hello'));
    const frame1 = r1.lastFrame() ?? "";
    console.log("bold amber frame (JSON):", JSON.stringify(frame1));
    
    const r2 = render(React.createElement(Text, { dimColor: true }, 'world'));
    const frame2 = r2.lastFrame() ?? "";
    console.log("dim frame (JSON):", JSON.stringify(frame2));
  });
});
