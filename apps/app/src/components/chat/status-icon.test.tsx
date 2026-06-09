// @vitest-environment jsdom
/**
 * status-icon.test.tsx
 *
 * Render tests for StatusIcon:
 *   - Each status renders the correct aria-label
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusIcon } from "./status-icon";

afterEach(cleanup);

// Stub lucide icons to simple spans with the label text
vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  // Stub every export as a vi.fn returning null, then override the three
  // icons StatusIcon uses that need to pass aria-label through.
  const stubs = Object.fromEntries(
    Object.keys(real).map((k) => [k, vi.fn(() => null)])
  );
  return {
    ...real,
    ...stubs,
    Check: vi.fn(({ "aria-label": label }: { "aria-label"?: string }) => <span aria-label={label}>✓</span>),
    Loader2: vi.fn(({ "aria-label": label }: { "aria-label"?: string }) => <span aria-label={label}>○</span>),
    X: vi.fn(({ "aria-label": label }: { "aria-label"?: string }) => <span aria-label={label}>✗</span>),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
}));

describe("StatusIcon", () => {
  it("renders 'Composing' for pending status", () => {
    render(<StatusIcon status="pending" />);
    expect(screen.getByLabelText("Composing")).toBeInTheDocument();
  });

  it("renders 'Running' for running status", () => {
    render(<StatusIcon status="running" />);
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
  });

  it("renders 'Completed' for completed status", () => {
    render(<StatusIcon status="completed" />);
    expect(screen.getByLabelText("Completed")).toBeInTheDocument();
  });

  it("renders 'Failed' for failed status", () => {
    render(<StatusIcon status="failed" />);
    expect(screen.getByLabelText("Failed")).toBeInTheDocument();
  });
});
