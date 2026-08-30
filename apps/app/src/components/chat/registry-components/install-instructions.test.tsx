// @vitest-environment jsdom
/**
 * install-instructions.test.tsx
 *
 * Render + interaction tests for InstallInstructions:
 *   - Renders client label
 *   - Renders each step with label text
 *   - Renders command code block when step has a command
 *   - Does not render code block for prose-only steps
 *   - Copy button exists for steps with commands
 *   - Falls back to raw client id when not in CLIENT_LABELS map
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InstallInstructions from "./install-instructions";

afterEach(cleanup);

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Copy: vi.fn(() => <span data-testid="icon-copy" />),
    Check: vi.fn(() => <span data-testid="icon-check" />),
    Terminal: vi.fn(() => <span data-testid="icon-terminal" />),
  };
});

const STEPS = [
  { label: "Install Node.js", command: "npm install -g @oxagen/cli" },
  { label: "Read the docs" },
  { label: "Configure your workspace", command: "oxagen init" },
];

describe("InstallInstructions", () => {
  it("renders the client label for known clients", () => {
    render(<InstallInstructions client="claude-code" steps={STEPS} />);
    expect(screen.getByText("Oxagen for Claude Code")).toBeInTheDocument();
  });

  it("renders the client label for unknown clients (falls back to raw id)", () => {
    render(<InstallInstructions client="my-custom-client" steps={STEPS} />);
    expect(screen.getByText("Oxagen for my-custom-client")).toBeInTheDocument();
  });

  it("renders each step label", () => {
    render(<InstallInstructions client="cursor" steps={STEPS} />);
    expect(screen.getByText("Install Node.js")).toBeInTheDocument();
    expect(screen.getByText("Read the docs")).toBeInTheDocument();
    expect(screen.getByText("Configure your workspace")).toBeInTheDocument();
  });

  it("renders command text in code block for steps with commands", () => {
    render(<InstallInstructions client="cursor" steps={STEPS} />);
    expect(screen.getByText("npm install -g @oxagen/cli")).toBeInTheDocument();
    expect(screen.getByText("oxagen init")).toBeInTheDocument();
  });

  it("does not render a code block for prose-only steps", () => {
    render(<InstallInstructions client="cursor" steps={STEPS} />);
    // "Read the docs" step has no command — only the label should appear
    const labelElem = screen.getByText("Read the docs");
    // Should be a plain paragraph, not inside a pre block
    expect(labelElem.closest("pre")).toBeNull();
  });

  it("renders copy buttons only for steps with commands", () => {
    render(<InstallInstructions client="cursor" steps={STEPS} />);
    // 2 steps have commands → 2 copy buttons
    const copyButtons = screen.getAllByRole("button");
    expect(copyButtons.length).toBe(2);
  });

  it("renders step numbers starting at 1", () => {
    render(<InstallInstructions client="cursor" steps={STEPS} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("copy button changes aria-label to 'step 1 command copied' after click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <InstallInstructions
        client="cursor"
        steps={[{ label: "Run", command: "oxagen go" }]}
      />,
    );
    const btn = screen.getByRole("button");
    await userEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith("oxagen go");
    await waitFor(() => {
      // After copy the aria-label changes to "step 1 command copied"
      expect(
        screen.getByRole("button", { name: /copied/i }),
      ).toBeInTheDocument();
    });
  });

  it("renders with correct region role and aria-label", () => {
    render(<InstallInstructions client="cursor" steps={STEPS} />);
    expect(screen.getByRole("region")).toHaveAttribute(
      "aria-label",
      "Install Oxagen for Cursor",
    );
  });

  it("renders the installation steps list with correct aria-label", () => {
    render(<InstallInstructions client="cursor" steps={STEPS} />);
    expect(
      screen.getByRole("list", { name: "Installation steps" }),
    ).toBeInTheDocument();
  });
});
