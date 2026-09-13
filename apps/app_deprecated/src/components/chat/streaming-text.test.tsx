// @vitest-environment jsdom
/**
 * streaming-text.test.tsx
 *
 * Render tests for StreamingText:
 *   - Under reduced motion, renders full text immediately (no animation)
 *   - Never renders a caret (removed: one caret per text segment read as noise)
 *   - Renders MarkdownMessage with the displayed text
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

// Reduced motion defaults to true so text renders immediately; individual
// tests flip it to false to exercise the animated reveal path.
const motionMock = vi.hoisted(() => ({ reduced: true }));
vi.mock("motion/react", () => ({
  useReducedMotion: () => motionMock.reduced,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("./markdown-message", () => ({
  MarkdownMessage: ({
    children,
    streaming: _streaming,
    className,
  }: {
    children: string;
    streaming?: boolean;
    className?: string;
  }) => (
    <div data-testid="markdown-message" className={className}>
      {children}
    </div>
  ),
}));

describe("StreamingText", () => {
  it("renders full text immediately under reduced motion", async () => {
    const { StreamingText } = await import("./streaming-text");
    render(<StreamingText text="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders MarkdownMessage with the text", async () => {
    const { StreamingText } = await import("./streaming-text");
    render(<StreamingText text="**Bold text**" />);
    expect(screen.getByTestId("markdown-message")).toBeInTheDocument();
    expect(screen.getByTestId("markdown-message")).toHaveTextContent(
      "**Bold text**",
    );
  });

  it("renders no caret while streaming", async () => {
    const { StreamingText } = await import("./streaming-text");
    render(<StreamingText text="Streaming" isStreaming={true} />);
    expect(document.querySelector(".stream-caret")).not.toBeInTheDocument();
  });

  it("renders no caret mid-reveal with motion enabled (the state that used to show one)", async () => {
    motionMock.reduced = false;
    // A no-op rAF freezes the reveal at count=0, pinning the component in the
    // mid-reveal state (count < text.length) where the caret used to render.
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const { StreamingText } = await import("./streaming-text");
      render(
        <StreamingText
          text="Streaming reveal in progress"
          isStreaming={true}
        />,
      );
      expect(document.querySelector(".stream-caret")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      motionMock.reduced = true;
    }
  });

  it("renders no caret when not streaming", async () => {
    const { StreamingText } = await import("./streaming-text");
    render(<StreamingText text="Static text" isStreaming={false} />);
    expect(document.querySelector(".stream-caret")).not.toBeInTheDocument();
  });

  it("renders empty string without crashing", async () => {
    const { StreamingText } = await import("./streaming-text");
    render(<StreamingText text="" />);
    expect(screen.getByTestId("markdown-message")).toBeInTheDocument();
  });

  it("applies custom className to the wrapper div", async () => {
    const { StreamingText } = await import("./streaming-text");
    const { container } = render(
      <StreamingText text="Some text" className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass("custom-class");
  });

  it("renders markdown message with streaming=false when not streaming", async () => {
    const { StreamingText } = await import("./streaming-text");
    // When reducedMotion=true and isStreaming=false, count=0 < text.length initially
    // but reduced motion skips animation — displayed is the full text
    render(<StreamingText text="Final text" isStreaming={false} />);
    const md = screen.getByTestId("markdown-message");
    expect(md).toHaveTextContent("Final text");
  });
});
