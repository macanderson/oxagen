// @vitest-environment jsdom
/**
 * copyable-id.test.tsx — render + interaction tests for CopyableId.
 *
 * Covers: truncation, optional label, aria-label, copy-to-clipboard callback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CopyableId } from "./copyable-id";

afterEach(cleanup);

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.assign(navigator, {
    clipboard: { writeText },
  });
});

describe("CopyableId", () => {
  it("renders the truncated value (default max=16)", () => {
    render(<CopyableId value="abcdefghijklmnopqrstuvwxyz" />);
    // truncate("abcdefghijklmnopqrstuvwxyz", 16) → "abcdefghijklmno…"
    expect(screen.getByText("abcdefghijklmno…")).toBeInTheDocument();
  });

  it("renders the full value when short enough", () => {
    render(<CopyableId value="short-id" />);
    expect(screen.getByText("short-id")).toBeInTheDocument();
  });

  it("renders the label when provided", () => {
    render(<CopyableId value="abc123" label="ID" />);
    expect(screen.getByText("ID")).toBeInTheDocument();
  });

  it("does not render a label element when omitted", () => {
    const { container } = render(<CopyableId value="abc123" />);
    // Only the value span and the icon, no label span with font-sans
    const spans = container.querySelectorAll("span.font-sans");
    expect(spans).toHaveLength(0);
  });

  it("aria-label includes the full value", () => {
    render(<CopyableId value="node-abc-123" label="ID" />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-label")).toBe("Copy ID node-abc-123");
  });

  it("aria-label uses 'identifier' when no label prop", () => {
    render(<CopyableId value="xyz-456" />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-label")).toBe("Copy identifier xyz-456");
  });

  it("clicking the button calls navigator.clipboard.writeText with the full value", async () => {
    render(<CopyableId value="full-value-to-copy" />);
    fireEvent.click(screen.getByRole("button"));
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("full-value-to-copy");
    });
  });

  it("respects a custom max for truncation", () => {
    render(<CopyableId value="hello world" max={6} />);
    // truncate("hello world", 6) → "hello…"
    expect(screen.getByText("hello…")).toBeInTheDocument();
  });

  it("truncates in the middle when ellipsis='middle', preserving the tail", () => {
    render(
      <CopyableId
        value="oxagen.default.qa-chat-assistant"
        max={16}
        ellipsis="middle"
      />,
    );
    // truncateMiddle keeps head + tail with a central ellipsis, so the
    // distinguishing suffix survives and the clip never reads as a typo.
    const shown = screen.getByText(/…/);
    expect(shown.textContent).toContain("…");
    // Head (namespace) and the value's real tail both survive the clip.
    expect(shown.textContent).toMatch(/^oxagen/);
    expect(shown.textContent!.endsWith("ant")).toBe(true);
    // Full value is still copied verbatim.
    fireEvent.click(screen.getByRole("button"));
    expect(writeText).toHaveBeenCalledWith("oxagen.default.qa-chat-assistant");
  });

  it("shows a short value verbatim in middle mode (no clip, no typo look)", () => {
    render(
      <CopyableId value="oxagen.default.qa-chat" max={28} ellipsis="middle" />,
    );
    expect(screen.getByText("oxagen.default.qa-chat")).toBeInTheDocument();
  });
});
