// @vitest-environment jsdom
/**
 * system-prompt-readonly.test.tsx — component tests for SystemPromptReadonly.
 *
 * Covers:
 *   (a) Renders the supplied effective system prompt verbatim.
 *   (b) Marks the surface read-only (badge) and exposes no editable controls.
 *   (c) Renders the prompt inside a <pre> for faithful, copyable display.
 */
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { SystemPromptReadonly } from "./system-prompt-readonly";

afterEach(() => cleanup());

const SAMPLE =
  "You are Oxagen, an interactive AI assistant.\n\n## Capabilities, Skills, MCP servers & Plugins";

describe("SystemPromptReadonly", () => {
  it("renders the supplied effective system prompt verbatim", () => {
    const { container } = render(<SystemPromptReadonly prompt={SAMPLE} />);
    expect(container.textContent).toContain(
      "You are Oxagen, an interactive AI assistant.",
    );
    expect(container.textContent).toContain(
      "## Capabilities, Skills, MCP servers & Plugins",
    );
  });

  it("marks the surface read-only and exposes no editable controls", () => {
    const { container } = render(<SystemPromptReadonly prompt={SAMPLE} />);
    expect(screen.getByText(/read-only/i)).toBeTruthy();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders the prompt inside a <pre> block", () => {
    const { container } = render(<SystemPromptReadonly prompt={SAMPLE} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("You are Oxagen");
  });
});
