// @vitest-environment jsdom
// The pager under a list: a missing step is disabled, a present one turns the
// page, a step given as a path is a link, and choosing a size from Rows per
// page reports it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes, type SafePath } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { RowsPager } from "./pagination";

afterEach(cleanup);

type Step = (() => void) | SafePath | null;

function renderPager(
  steps: { previous: Step; next: Step },
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
    const next = vi.fn<() => void>();
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
    renderPager({ previous: vi.fn<() => void>(), next: null }, onPerPage);
    const rows = screen.getByRole("combobox", { name: "Rows per page" });
    expect(rows).toHaveTextContent("25");
    await userEvent.click(rows);
    await userEvent.click(await screen.findByRole("option", { name: "50" }));
    await waitFor(() => {
      expect(onPerPage).toHaveBeenCalledWith(50);
    });
  });

  it("draws a step given as a path as a link to that path", async () => {
    const older = routes.audit("acme", { offset: "25" });
    const { container } = renderPager({ previous: null, next: older });
    const link = screen.getByRole("link", { name: "Next" });
    expect(link).toHaveAttribute("href", "/acme/audit?offset=25");
    // Base UI's button gives what it renders role="button", so a path step
    // is drawn as a plain link and a screen reader hears a link.
    expect(link).not.toHaveAttribute("role");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await expectNoAxe(container);
  });

  it("names a size with the label the list gives it, and draws what sits beside the range", async () => {
    render(
      <RowsPager
        label="Pages"
        rowsLabel="Rows"
        perPage={0}
        sizes={[10, 0]}
        onPerPage={vi.fn()}
        sizeLabel={(size) => (size === 0 ? "All" : String(size))}
        range="1–12 of 12"
        beside={<a href="#retired">3 retired</a>}
        previousLabel="Previous"
        nextLabel="Next"
        previous={null}
        next={null}
      />,
    );
    const rows = screen.getByRole("combobox", { name: "Rows" });
    expect(rows).toHaveTextContent("All");
    await userEvent.click(rows);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["10", "All"]);
    expect(screen.getByRole("link", { name: "3 retired" })).toBeTruthy();
  });
});
