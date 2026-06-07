// @vitest-environment jsdom
/**
 * markdown-message.test.tsx
 *
 * Render tests for MarkdownMessage:
 *   - Renders children text content
 *   - Passes streaming prop correctly
 *   - Applies className
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

// Mock the streamdown and plugin packages which require Node/browser APIs
vi.mock("streamdown", () => ({
  Streamdown: ({
    children,
    className,
  }: {
    children: string;
    parseIncompleteMarkdown?: boolean;
    shikiTheme?: unknown;
    mermaid?: unknown;
    plugins?: unknown;
    controls?: unknown;
    className?: string;
  }) => (
    <div data-testid="streamdown" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@streamdown/code", () => ({
  createCodePlugin: () => ({ name: "code" }),
}));

vi.mock("@streamdown/mermaid", () => ({
  createMermaidPlugin: () => ({ name: "mermaid" }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("MarkdownMessage", () => {
  it("renders text content", async () => {
    const { MarkdownMessage } = await import("./markdown-message");
    render(<MarkdownMessage>Hello world</MarkdownMessage>);
    expect(screen.getByTestId("streamdown")).toHaveTextContent("Hello world");
  });

  it("renders without crashing with empty string", async () => {
    const { MarkdownMessage } = await import("./markdown-message");
    render(<MarkdownMessage>{""}</MarkdownMessage>);
    expect(screen.getByTestId("streamdown")).toBeInTheDocument();
  });

  it("passes className to Streamdown", async () => {
    const { MarkdownMessage } = await import("./markdown-message");
    render(<MarkdownMessage className="custom-md">text</MarkdownMessage>);
    expect(screen.getByTestId("streamdown")).toHaveClass("custom-md");
  });

  it("renders markdown content as-is through the Streamdown stub", async () => {
    const { MarkdownMessage } = await import("./markdown-message");
    render(<MarkdownMessage>## Heading{"\n\nParagraph"}</MarkdownMessage>);
    expect(screen.getByTestId("streamdown")).toHaveTextContent("## Heading");
  });
});
