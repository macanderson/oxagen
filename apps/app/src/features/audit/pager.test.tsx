// @vitest-environment jsdom
// The pager under the audit record (#4693): Previous and Next are links to the
// addresses the server built, a missing step is a disabled button, and picking
// a size from Rows per page visits the first page at that size.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes, type SafePath } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@/ui/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/navigation")>()),
  useNavigate: () => ({
    push,
    replace: vi.fn(),
    refresh: vi.fn(),
    advance: vi.fn(),
  }),
}));

const { AuditPager } = await import("./pager");

beforeEach(() => {
  push.mockReset();
});
afterEach(cleanup);

const SIZES = [5, 10, 25, 50].map((size) => ({
  size,
  first: routes.audit(
    "acme",
    size === 10 ? { outcome: "deny" } : { outcome: "deny", rows: String(size) },
  ),
}));

function renderPager(steps: {
  previous: SafePath | null;
  next: SafePath | null;
}) {
  return render(
    <AuditPager
      label="Pages"
      rowsLabel="Rows"
      previousLabel="Previous page"
      nextLabel="Next page"
      perPage={10}
      sizes={SIZES}
      range={<span data-testid="audit-shown">1–10 of 30</span>}
      {...steps}
    />,
  );
}

describe("AuditPager", () => {
  it("links Next to the older page and disables Previous on the first", async () => {
    const { container } = renderPager({
      previous: null,
      next: routes.audit("acme", { outcome: "deny", offset: "10" }),
    });
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/acme/audit?outcome=deny&offset=10",
    );
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Previous page" })).toBeNull();
    // The range sits beside Rows, outside the Previous and Next landmark.
    const pages = screen.getByRole("navigation", { name: "Pages" });
    expect(screen.getByTestId("audit-shown")).toHaveTextContent("1–10 of 30");
    expect(pages.contains(screen.getByTestId("audit-shown"))).toBe(false);
    await expectNoAxe(container);
  });

  it("links Previous to the newer page and disables Next past the last", () => {
    renderPager({
      previous: routes.audit("acme", { outcome: "deny", offset: "10" }),
      next: null,
    });
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/acme/audit?outcome=deny&offset=10",
    );
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
  });

  it("visits the first page at the size picked from Rows", async () => {
    renderPager({ previous: null, next: null });
    const rows = screen.getByRole("combobox", { name: "Rows" });
    expect(rows).toHaveTextContent("10");
    await userEvent.click(rows);
    await userEvent.click(await screen.findByRole("option", { name: "25" }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/acme/audit?outcome=deny&rows=25");
    });
    expect(push).toHaveBeenCalledOnce();
  });

  it("stays on the page when the size already showing is picked (negative)", async () => {
    renderPager({ previous: null, next: null });
    await userEvent.click(screen.getByRole("combobox", { name: "Rows" }));
    await userEvent.click(await screen.findByRole("option", { name: "10" }));
    expect(push).not.toHaveBeenCalled();
  });
});
