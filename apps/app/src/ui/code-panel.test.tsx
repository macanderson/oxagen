// @vitest-environment jsdom
// The read-only code block: the code exactly as written and coloured with
// the house tokens. Axe runs on the state each test ends in (INV-26).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { CodeBlock } from "./code-panel";

afterEach(cleanup);

describe("CodeBlock", () => {
  const json = '{\n  "data_source_id": "f336d0bc",\n  "count": 2\n}';

  it("keeps the code exactly as written, line breaks included", async () => {
    const { container } = render(
      <CodeBlock code={json} language="json" label="Add properties" />,
    );
    const block = screen.getByRole("group", { name: "Add properties" });
    expect(block.tagName).toBe("PRE");
    expect(block.textContent).toBe(json);
    await expectNoAxe(container);
  });

  it("colours keys, strings, and numbers with the house tokens", () => {
    render(<CodeBlock code={json} language="json" />);
    const block = document.querySelector("[data-code-block]");
    expect(block?.querySelector(".text-code-key")?.textContent).toBe(
      '"data_source_id"',
    );
    expect(block?.querySelector(".text-code-string")?.textContent).toBe(
      '"f336d0bc"',
    );
    expect(block?.querySelector(".text-code-number")?.textContent).toBe("2");
  });

  it("draws plain text with no token colours", () => {
    render(<CodeBlock code="ADD COLUMN Priority" />);
    const block = document.querySelector("[data-code-block]");
    expect(block?.textContent).toBe("ADD COLUMN Priority");
    expect(block?.querySelector("span")).toBeNull();
  });
});
