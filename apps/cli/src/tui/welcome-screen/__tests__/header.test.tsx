import { describe, test, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Header } from "../header.js";

describe("Header", () => {
  test("renders version string", () => {
    const { lastFrame } = render(<Header version="0.6.2" />);
    expect(lastFrame()).toContain("v0.6.2");
  });

  test("renders OXAGEN wordmark", () => {
    const { lastFrame } = render(<Header version="1.0.0" />);
    const output = lastFrame();
    
    // Should contain the word OXAGEN in block letters
    expect(output).toContain("██████");
    expect(output).toContain("OXAGEN");
  });

  test("renders tagline", () => {
    const { lastFrame } = render(<Header version="1.0.0" />);
    expect(lastFrame()).toContain("Agentic Coding Assistant");
  });

  test("renders subtitle with context engine reference", () => {
    const { lastFrame } = render(<Header version="1.0.0" />);
    expect(lastFrame()).toContain("Knowledge-Graph Context Engine");
  });

  test("renders decorative borders", () => {
    const { lastFrame } = render(<Header version="1.0.0" />);
    const output = lastFrame();
    // Unicode box-drawing characters
    expect(output).toContain("━");
  });

  test("displays status when provided", () => {
    const { lastFrame } = render(
      <Header version="1.0.0" status="Connected" connected={true} />
    );
    expect(lastFrame()).toContain("Connected");
  });

  test("shows green indicator when connected", () => {
    const { lastFrame } = render(
      <Header version="1.0.0" status="Ready" connected={true} />
    );
    const output = lastFrame();
    // Green dot indicator (●) should be present
    expect(output).toContain("●");
  });

  test("shows red indicator when disconnected", () => {
    const { lastFrame } = render(
      <Header version="1.0.0" status="Offline" connected={false} />
    );
    const output = lastFrame();
    // Red/hollow dot indicator
    expect(output).toMatch(/[○●]/);
  });

  test("omits status section when not provided", () => {
    const { lastFrame } = render(<Header version="1.0.0" />);
    const output = lastFrame();
    // Should not have the status indicator dot
    expect(output).not.toContain("●");
    expect(output).not.toContain("○");
  });

  test("includes brand ring glyph", () => {
    const { lastFrame } = render(<Header version="1.0.0" />);
    expect(lastFrame()).toContain("◯");
  });
});
