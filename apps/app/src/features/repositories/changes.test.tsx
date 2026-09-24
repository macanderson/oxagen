// @vitest-environment jsdom
// The Changes tab's table on its own: a row opens by keyboard as well as by
// click, a search that matches nothing says so rather than claiming the
// workspace has no changes, and the CI light says each state in its own shape.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type {
  RepositoryChange,
  RepositoryChanges,
} from "@/data/contracts/repository";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { Changes, CiLight } from "./changes";

const change = (
  proposalId: string,
  status: RepositoryChange["status"],
): RepositoryChange => ({
  proposalId,
  lineage: `ctx.scr.${proposalId}`,
  statement: `Statement ${proposalId}`,
  why: "",
  kind: "context_record",
  pullRequest: {
    number: 7,
    url: "https://github.com/acme/platform/pull/7",
    repository: "acme/platform",
    branch: `context/${proposalId}`,
  },
  openedBy: "the reconciler",
  status,
  checks: { passed: 2, total: 6 },
  openedAt: "2026-09-18T10:00:00.000Z",
});

const VALUE: RepositoryChanges = {
  changes: [
    change("prp_run1", "checks_running"),
    change("prp_pass1", "checks_passed"),
    change("prp_open1", "pr_open"),
  ],
  open: 3,
};

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function table(onOpen = vi.fn()) {
  const { container } = render(
    <IntlProvider>
      <Changes changes={{ kind: "ready", value: VALUE }} onOpen={onOpen} />
    </IntlProvider>,
  );
  return { onOpen, container };
}

describe("the Changes table", () => {
  it("opens a row with Enter or Space, and ignores other keys", async () => {
    const user = userEvent.setup();
    const { onOpen } = table();
    const row = screen.getByTestId("change-row-prp_run1");
    row.focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith("prp_run1");
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(2);
    await user.keyboard("a");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("ignores a key pressed on something inside the row rather than the row itself (negative)", () => {
    const { onOpen } = table();
    const row = screen.getByTestId("change-row-prp_run1");
    const inner = within(row).getByText("ctx.scr.prp_run1");
    inner.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says no rows match when a search hides every change, not that there are none (negative)", async () => {
    const user = userEvent.setup();
    table();
    await user.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "nothing-like-this",
    );
    expect(screen.getByTestId("changes-empty")).toHaveTextContent(
      "No rows match.",
    );
  });

  it("draws running as a pulse, passed as green, and an open change as queued", async () => {
    const { container } = table();
    const light = (id: string) =>
      screen
        .getByTestId(`change-row-${id}`)
        .querySelector("[data-ci]")
        ?.getAttribute("data-ci");
    expect(light("prp_run1")).toBe("running");
    expect(light("prp_pass1")).toBe("passed");
    expect(light("prp_open1")).toBe("queued");
    expect(screen.getByTestId("change-row-prp_open1")).toHaveTextContent(
      "the reconciler",
    );
    await expectNoAxe(container);
  });

  it("reads a merged change as passed, and a failed one as a cross", () => {
    const { container, rerender } = render(<CiLight status="merged" />);
    expect(container.querySelector("[data-ci]")).toHaveAttribute(
      "data-ci",
      "passed",
    );
    rerender(<CiLight status="checks_failed" />);
    expect(container.querySelector("[data-ci]")).toHaveTextContent("✕");
    expect(container.querySelector("[data-ci]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
