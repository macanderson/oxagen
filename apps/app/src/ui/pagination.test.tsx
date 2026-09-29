// @vitest-environment jsdom
// The pager under a list: a missing step is disabled, a present one turns the
// page, and choosing a size from Rows per page reports it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { RowsPager } from "./pagination";

afterEach(cleanup);

function renderPager(
  steps: { previous: (() => void) | null; next: (() => void) | null },
  onPerPage = vi.fn(),
) {
  return render(
    <RowsPager
      label="Pages"
      rowsLabel="Rows per page"
      perPage={25}
      sizes={[10, 25, 50, 100]}
      onPerPage={onPerPage}
      range="1–25 of 60"
      previousLabel="Previous"
      nextLabel="Next"
      {...steps}
    />,
  );
}

describe("RowsPager", () => {
  it("disables a step with no page that way and turns the other", async () => {
    const next = vi.fn();
    const { container } = renderPager({ previous: null, next });
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(next).toHaveBeenCalledOnce();
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeTruthy();
    expect(screen.getByText("1–25 of 60")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("reports the size chosen from Rows per page", async () => {
    const onPerPage = vi.fn();
    renderPager({ previous: vi.fn(), next: null }, onPerPage);
    const rows = screen.getByRole("combobox", { name: "Rows per page" });
    expect(rows).toHaveTextContent("25");
    await userEvent.click(rows);
    await userEvent.click(await screen.findByRole("option", { name: "50" }));
    await waitFor(() => {
      expect(onPerPage).toHaveBeenCalledWith(50);
    });
  });
});
