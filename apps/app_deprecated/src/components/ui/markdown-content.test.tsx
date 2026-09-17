// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Stub the Streamdown wrapper; we only need to verify MarkdownContent forwards
// its children and className through to the shared markdown renderer.
vi.mock("@/components/chat/markdown-message", () => ({
  MarkdownMessage: ({
    children,
    className,
  }: {
    children: string;
    className?: string;
  }) => (
    <div data-testid="markdown" className={className}>
      {children}
    </div>
  ),
}));

import { MarkdownContent } from "./markdown-content";

afterEach(cleanup);

describe("MarkdownContent", () => {
  it("forwards the markdown source to the shared renderer", () => {
    render(<MarkdownContent>{"# Title"}</MarkdownContent>);
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Title");
  });

  it("merges an extra className onto the renderer", () => {
    render(
      <MarkdownContent className="custom-class">{"body"}</MarkdownContent>,
    );
    expect(screen.getByTestId("markdown").className).toContain("custom-class");
  });
});
