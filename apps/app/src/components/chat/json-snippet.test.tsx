// @vitest-environment jsdom
/**
 * json-snippet.test.tsx
 *
 * The plain renderer for bulky tool results:
 *   - Pretty-prints the value as 2-space JSON in a <pre>
 *   - Syntax-highlights via the shared diff-syntax highlighter (mocked here —
 *     shiki needs WASM; the real tokenizer is covered by diff-syntax.test.ts)
 *   - Clips past the line budget behind a "Show all N lines" toggle
 *   - Copies the full JSON via the icon button, even while clipped
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { JsonSnippet, toPrettyJson } from "./json-snippet";

afterEach(cleanup);

vi.mock("./registry-components/diff-syntax", () => ({
  // One cyan token per line — enough to prove tokens render with .diff-token.
  highlightLine: vi.fn(async (line: string) => [
    { content: line, style: "color:#0aa;--shiki-dark:#0ff" },
  ]),
}));

describe("toPrettyJson", () => {
  it("pretty-prints with 2-space indentation and never throws", () => {
    expect(toPrettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof toPrettyJson(circular)).toBe("string");
  });
});

describe("JsonSnippet", () => {
  const nodes = {
    nodes: Array.from({ length: 12 }, (_, i) => ({
      id: `node-${i}`,
      label: "Person",
      score: 0.9 - i * 0.01,
    })),
  };

  it("renders the pretty JSON inside a pre block", () => {
    render(<JsonSnippet value={{ query: "acme", limit: 5 }} />);
    const root = document.querySelector("[data-component='json-snippet']");
    expect(root).not.toBeNull();
    const pre = root!.querySelector("pre");
    expect(pre?.textContent).toContain('"query": "acme"');
    expect(pre?.textContent).toContain('"limit": 5');
  });

  it("clips long documents and expands via the show-all toggle", () => {
    render(<JsonSnippet value={nodes} clipLines={6} />);
    const pre = document.querySelector("[data-component='json-snippet'] pre")!;
    // Clipped: the last node is not visible yet.
    expect(pre.textContent).not.toContain("node-11");
    const total = toPrettyJson(nodes).split("\n").length;
    const toggle = screen.getByRole("button", {
      name: `Show all ${total} lines`,
    });
    fireEvent.click(toggle);
    expect(pre.textContent).toContain("node-11");
    fireEvent.click(screen.getByRole("button", { name: /Collapse/ }));
    expect(pre.textContent).not.toContain("node-11");
  });

  it("shows no toggle when the document fits the clip budget", () => {
    render(<JsonSnippet value={{ ok: true }} />);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("copies the FULL JSON from the icon button even while clipped", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<JsonSnippet value={nodes} clipLines={4} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(toPrettyJson(nodes)),
    );
  });

  it("colours in asynchronously with .diff-token dual-theme spans", async () => {
    render(<JsonSnippet value={{ a: 1 }} />);
    await waitFor(() => {
      expect(document.querySelector("span.diff-token")).not.toBeNull();
    });
  });
});
