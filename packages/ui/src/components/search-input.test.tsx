// @vitest-environment jsdom
/**
 * search-input.test.tsx — behaviour tests for SearchInput.
 *
 * Covers: search glyph, typing, clear affordance visibility + click.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "./search-input";

afterEach(cleanup);

describe("SearchInput", () => {
  it("renders a search-type input with the leading glyph padding", () => {
    render(<SearchInput placeholder="Search tools" />);
    const input = screen.getByPlaceholderText("Search tools");
    expect(input.getAttribute("type")).toBe("search");
    expect(input.className).toContain("pl-8");
  });

  it("forwards typing to onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchInput placeholder="Search" onChange={onChange} />);
    await user.type(screen.getByPlaceholderText("Search"), "graph");
    expect(onChange).toHaveBeenCalled();
  });

  it("hides the clear button while empty, shows it with a value", () => {
    const { rerender } = render(
      <SearchInput
        placeholder="Search"
        value=""
        onChange={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    rerender(
      <SearchInput
        placeholder="Search"
        value="neo4j"
        onChange={() => {}}
        onClear={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Clear search" }),
    ).toBeInTheDocument();
  });

  it("never shows a clear button without onClear", () => {
    render(<SearchInput placeholder="Search" value="x" onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("calls onClear when the clear button is clicked", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <SearchInput
        placeholder="Search"
        value="x"
        onChange={() => {}}
        onClear={onClear}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
