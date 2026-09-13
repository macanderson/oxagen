// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub the Streamdown-based renderer so the popover's markdown path is exercised
// without pulling the real Shiki/Streamdown pipeline into jsdom.
vi.mock("@/components/chat/markdown-message", () => ({
  MarkdownMessage: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

import { TruncatedText } from "./truncated-text";

// Force the preview element to report overflow. jsdom returns 0 for both
// scrollHeight and clientHeight, so the component would never see an overflow;
// override the getters to simulate clamped, overflowing content.
function setOverflow(overflowing: boolean) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => (overflowing ? 200 : 20),
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 20,
  });
}

afterEach(() => {
  cleanup();
  // Restore jsdom defaults.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
    "scrollHeight"
  ];
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
    "clientHeight"
  ];
});

describe("TruncatedText", () => {
  beforeEach(() => setOverflow(false));

  it("renders a markdown-stripped preview and no reveal when content fits", () => {
    render(<TruncatedText text="# Heading with **bold**" />);
    // Markdown syntax is stripped from the preview.
    expect(screen.getByText("Heading with bold")).toBeInTheDocument();
    // Not overflowing → no reveal trigger.
    expect(
      screen.queryByRole("button", { name: /show full text/i }),
    ).toBeNull();
  });

  it("renders plain text unchanged when markdown is disabled", () => {
    render(<TruncatedText text="# not markdown" markdown={false} />);
    expect(screen.getByText("# not markdown")).toBeInTheDocument();
  });

  it("shows an ellipsis reveal that opens the full formatted text in a popover", async () => {
    setOverflow(true);
    render(<TruncatedText text="A very long **memory** body that overflows" />);

    const trigger = await screen.findByRole("button", {
      name: /show full text/i,
    });
    expect(trigger).toBeInTheDocument();

    await userEvent.click(trigger);

    // The popover renders the FULL content through the markdown renderer.
    const md = await screen.findByTestId("markdown");
    expect(md).toHaveTextContent("A very long **memory** body that overflows");
  });

  it("reveals full plain text (no markdown) when markdown is disabled and overflowing", async () => {
    setOverflow(true);
    render(
      <TruncatedText
        text="raw *stars* stay"
        markdown={false}
        revealLabel="Expand"
      />,
    );

    const trigger = await screen.findByRole("button", { name: /expand/i });
    await userEvent.click(trigger);

    // No markdown renderer used; the raw text is shown verbatim in the popover.
    expect(screen.queryByTestId("markdown")).toBeNull();
    const popups = screen.getAllByText("raw *stars* stay");
    expect(popups.length).toBeGreaterThan(0);
  });

  it("honours a custom clamp line count", () => {
    setOverflow(false);
    const { container } = render(<TruncatedText text="clamp me" lines={4} />);
    expect(within(container).getByText("clamp me").className).toContain(
      "line-clamp-4",
    );
  });
});
