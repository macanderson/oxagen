import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Markdown } from "../markdown.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("Markdown", () => {
  it("renders emphasis with the markers consumed", () => {
    const { lastFrame } = render(
      <Markdown>{"this is **important** and *subtle*"}</Markdown>,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("important");
    expect(frame).toContain("subtle");
    expect(frame).not.toContain("**");
  });

  it("renders inline code with the backticks consumed", () => {
    const { lastFrame } = render(
      <Markdown>{"run `pnpm dev` locally"}</Markdown>,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("pnpm dev");
    expect(frame).not.toContain("`");
  });

  it("keeps fenced code block content", () => {
    const { lastFrame } = render(
      <Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("const x = 1;");
    expect(frame).not.toContain("```");
  });

  it("renders list items", () => {
    const { lastFrame } = render(
      <Markdown>{"- first thing\n- second thing"}</Markdown>,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("first thing");
    expect(frame).toContain("second thing");
  });

  it("never throws on malformed markdown — falls back to the raw text", () => {
    // An unterminated fence is the classic partial-stream shape.
    const raw = "some text\n```ts\nunclosed";
    const { lastFrame } = render(<Markdown>{raw}</Markdown>);
    expect(strip(lastFrame() ?? "")).toContain("unclosed");
  });
});
