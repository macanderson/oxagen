// @vitest-environment jsdom
/**
 * list-pagination.test.tsx — smoke tests for ListPagination.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListPagination } from "./list-pagination";

afterEach(cleanup);

describe("ListPagination", () => {
  it("renders nothing when pageCount is 1", () => {
    const { container } = render(
      <ListPagination page={1} pageCount={1} onPageChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when pageCount is 0", () => {
    const { container } = render(
      <ListPagination page={1} pageCount={0} onPageChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current page and total", () => {
    render(<ListPagination page={2} pageCount={5} onPageChange={vi.fn()} />);
    expect(screen.getByText("Page 2 of 5")).toBeInTheDocument();
  });

  it("disables Prev on the first page", () => {
    render(<ListPagination page={1} pageCount={5} onPageChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("disables Next on the last page", () => {
    render(<ListPagination page={5} pageCount={5} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("calls onPageChange with page - 1 when Prev is clicked", async () => {
    const onPageChange = vi.fn();
    render(
      <ListPagination page={3} pageCount={5} onPageChange={onPageChange} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Previous page" }),
    );
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("calls onPageChange with page + 1 when Next is clicked", async () => {
    const onPageChange = vi.fn();
    render(
      <ListPagination page={3} pageCount={5} onPageChange={onPageChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });
});
