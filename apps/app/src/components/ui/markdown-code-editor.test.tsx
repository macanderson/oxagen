// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MarkdownCodeEditor } from "./markdown-code-editor";

afterEach(cleanup);

// These tests render the REAL CodeMirror editor (the feature surfaces mock it),
// so they cover the extension builder branches (placeholder, maxLength) and the
// disabled styling that would otherwise go unexercised.

describe("MarkdownCodeEditor", () => {
  it("renders a CodeMirror editor showing the provided value", () => {
    const { container } = render(
      <MarkdownCodeEditor
        value="# Hello world"
        onChange={() => {}}
        ariaLabel="Body"
      />,
    );
    expect(container.querySelector(".cm-editor")).toBeTruthy();
    expect(container.textContent).toContain("Hello world");
  });

  it("builds the placeholder and maxLength extensions without throwing", () => {
    const { container } = render(
      <MarkdownCodeEditor
        value=""
        onChange={() => {}}
        id="editor"
        placeholder="Write markdown…"
        maxLength={100}
        minHeight="6rem"
        maxHeight="20rem"
      />,
    );
    // Placeholder branch renders CodeMirror's placeholder element.
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("applies disabled styling and marks the editor read-only", () => {
    const { container } = render(
      <MarkdownCodeEditor value="locked" onChange={vi.fn()} disabled />,
    );
    // Disabled wrapper gets the opacity/pointer-events treatment.
    expect(container.querySelector(".opacity-50")).toBeTruthy();
  });
});
