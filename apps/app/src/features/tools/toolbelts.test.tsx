// @vitest-environment jsdom
// The Toolbelts tab (ADR-192) on view models built through the live mappers:
// the list from list_toolbelts with All tools first, who is offered New
// toolbelt and Clone, the belt the URL opens below the list, and a refused
// read of either one stated in place. axe checks the state each test ends in
// (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  cloneToolbelt: vi.fn(),
  updateToolbelt: vi.fn(),
  deleteToolbelt: vi.fn(),
  setToolState: vi.fn(),
}));

const { Toolbelts } = await import("./toolbelts");
const { toolbeltDetail, toolbeltList } = await import("./tools.builders");

const at = { org: "acme", ws: "core-platform" };

function withIntl(element: ReactNode) {
  return render(<IntlProvider>{element}</IntlProvider>);
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Toolbelts › list", () => {
  it("lists All tools first, then its clones, with each belt's counts and a link that opens it", () => {
    withIntl(
      <Toolbelts
        at={at}
        canEdit={false}
        list={readOk(toolbeltList())}
        open={null}
      />,
    );
    const rows = screen.getAllByTestId("toolbelt-row");
    expect(rows.map((row) => row.getAttribute("data-belt"))).toEqual([
      "tbt_alltools",
      "tbt_reviewbelt",
    ]);
    const [all, review] = rows;
    if (all === undefined || review === undefined) throw new Error("no rows");
    expect(within(all).getByText("Every available tool")).toBeVisible();
    expect(within(review).getByText("Clone of All tools")).toBeVisible();
    expect(
      within(review).getByRole("link", { name: "Open Review belt" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/tools/toolbelts?belt=tbt_reviewbelt",
    );
    expect(
      within(all)
        .getAllByRole("cell")
        .slice(1)
        .map((c) => c.textContent),
    ).toEqual(["3", "2", "2", "1"]);
    expect(screen.queryByTestId("tools-belt")).not.toBeInTheDocument();
    expect(screen.getByText(/A toolbelt grants nothing/)).toBeVisible();
  });

  it("offers an admin New toolbelt, cloning All tools, and a Clone on every row", () => {
    withIntl(
      <Toolbelts at={at} canEdit list={readOk(toolbeltList())} open={null} />,
    );
    expect(screen.getByTestId("tools-belt-new")).toHaveTextContent(
      "New toolbelt",
    );
    expect(
      screen.getByTestId("toolbelt-clone-tbt_alltools"),
    ).toHaveAccessibleName("Clone All tools");
    expect(
      screen.getByTestId("toolbelt-clone-tbt_reviewbelt"),
    ).toHaveAccessibleName("Clone Review belt");
  });

  it("offers anyone else neither", () => {
    withIntl(
      <Toolbelts
        at={at}
        canEdit={false}
        list={readOk(toolbeltList())}
        open={null}
      />,
    );
    expect(screen.queryByTestId("tools-belt-new")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("states a refused list in place of the rows, and offers no New toolbelt", () => {
    withIntl(
      <Toolbelts
        at={at}
        canEdit
        list={readError("toolbelts_unavailable", 503)}
        open={null}
      />,
    );
    expect(
      screen.getByText(
        "Toolbelts could not be loaded: the control plane answered toolbelts_unavailable. Nothing was changed, and runs kept recording.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tools-belt-new")).not.toBeInTheDocument();
  });
});

describe("Toolbelts › open belt", () => {
  it("marks the open belt's row and draws the belt below the list", () => {
    withIntl(
      <Toolbelts
        at={at}
        canEdit={false}
        list={readOk(toolbeltList())}
        open={readOk(toolbeltDetail())}
      />,
    );
    const review = screen
      .getAllByTestId("toolbelt-row")
      .find((row) => row.getAttribute("data-belt") === "tbt_reviewbelt");
    expect(review).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("tools-belt")).toHaveAttribute(
      "data-belt",
      "tbt_reviewbelt",
    );
  });

  it("states a refused belt below the list with a way back", () => {
    withIntl(
      <Toolbelts
        at={at}
        canEdit={false}
        list={readOk(toolbeltList())}
        open={{ ok: false, reason: "denied", permission: "tools.read" }}
      />,
    );
    const failure = screen.getByTestId("tools-belt-failure");
    expect(
      within(failure).getByText(
        "You cannot see Toolbelts in this workspace. Your roles do not include tools.read; an organization owner can grant it.",
      ),
    ).toBeVisible();
    expect(
      within(failure).getByRole("link", { name: "Close" }),
    ).toHaveAttribute("href", "/acme/core-platform/tools/toolbelts");
    expect(screen.queryByTestId("tools-belt")).not.toBeInTheDocument();
  });
});
