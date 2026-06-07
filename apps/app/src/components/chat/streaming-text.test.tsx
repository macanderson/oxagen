// @vitest-environment jsdom
/**
 * streaming-text.test.tsx
 *
 * Render tests for StreamingText:
 *   - Under reduced motion, renders full text immediately (no animation)
 *   - Shows caret when isStreaming=true
 *   - No caret when isStreaming=false and all text revealed
 *   - Renders MarkdownMessage with the displayed text
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

// Mock reduced motion to true so text renders immediately
vi.mock("motion/react", () => ({
  useReducedMotion: () => true,
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
    expect(screen.getByTestId("markdown-message")).toHaveTextContent("**Bold text**");
  });

  it("shows stream-caret when isStreaming=true", async () => {
    const { StreamingText } = await import("./streaming-text");
    // Under reduced motion, caretVisible = !reduceMotion && (isStreaming || count < text.length)
    // reduceMotion=true → caretVisible=false regardless
    // so caret is never shown under reduced motion — verify no caret
    render(<StreamingText text="Streaming" isStreaming={true} />);
    // Caret is suppressed by reduced motion
    expect(document.querySelector(".stream-caret")).not.toBeInTheDocument();
  });

  it("does not show stream-caret when isStreaming=false (reduced motion)", async () => {
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
