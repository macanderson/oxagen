// @vitest-environment jsdom
// A provider's markdown renders as HTML, and the raw HTML in it renders as the
// text it was written as: a placeholder keeps its angle brackets, a tag never
// becomes an element, and an image is never fetched.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { ProseMarkdown } from "./prose-markdown";

describe("ProseMarkdown", () => {
  it("renders headings, lists, and emphasis", async () => {
    const { container } = render(
      <ProseMarkdown>
        {"## Statements\n\n- First *step*\n- Second step"}
      </ProseMarkdown>,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Statements" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("step").tagName).toBe("EM");
    await expectNoAxe(container);
  });

  it("keeps an inline placeholder in angle brackets as text", () => {
    render(<ProseMarkdown>{'ADD COLUMN "Name" <type> to it'}</ProseMarkdown>);
    expect(
      screen.getByText('ADD COLUMN "Name" <type> to it'),
    ).toBeInTheDocument();
    expect(document.querySelector("type")).toBeNull();
  });

  it("keeps a tag on a line of its own as a paragraph of text", () => {
    const { container } = render(
      <ProseMarkdown>
        {'Lead.\n\n<script>alert("x")</script>\n\n<data-source>'}
      </ProseMarkdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("data-source")).toBeNull();
    expect(container).toHaveTextContent('<script>alert("x")</script>');
    expect(screen.getByText("<data-source>").tagName).toBe("P");
  });

  it("renders an image as its alt text and never requests it", () => {
    const { container } = render(
      <ProseMarkdown>
        {"![Tracking pixel](https://tracker.example/p.png)"}
      </ProseMarkdown>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Tracking pixel")).toBeInTheDocument();
  });

  it("blocks a script link and keeps a web link behind a confirmation", () => {
    const { container } = render(
      <ProseMarkdown>
        {"[bad](javascript:alert(1)) and [docs](https://example.com/docs)"}
      </ProseMarkdown>,
    );
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(screen.getByText(/bad/)).not.toHaveAttribute("data-streamdown");
    // Streamdown opens a web link from a button that asks before leaving.
    expect(screen.getByRole("button", { name: "docs" })).toHaveAttribute(
      "data-streamdown",
      "link",
    );
  });

  it("renders fenced code as a code block in its language", () => {
    const { container } = render(
      <ProseMarkdown>{'```json\n{"a": 1}\n```'}</ProseMarkdown>,
    );
    const block = container.querySelector(
      '[data-streamdown="code-block"][data-language="json"]',
    );
    expect(block).toHaveTextContent('{"a": 1}');
  });
});
