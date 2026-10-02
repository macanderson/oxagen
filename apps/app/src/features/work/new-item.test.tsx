// @vitest-environment jsdom
// The New work item dialog: what it sends to createWorkItem, where it goes on
// success, how it shows a refusal, and that an empty title is refused before
// anything is sent. Each state runs the axe check (INV-26).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, createWorkItem } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  createWorkItem: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ createWorkItem }));

const { NewWorkItem } = await import("./new-item");

function draw(canControl = true) {
  render(
    <IntlProvider>
      <NewWorkItem org="a-intel" ws="core-platform" canControl={canControl} />
    </IntlProvider>,
  );
}

async function openDialog() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("work-new-item"));
  expect(await screen.findByTestId("work-new-item-dialog")).toBeInTheDocument();
  return user;
}

beforeEach(() => {
  createWorkItem.mockReset();
  router.push.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("New work item", () => {
  it("sends the title, description and repository, then opens the new item", async () => {
    createWorkItem.mockResolvedValue({
      ok: true,
      value: { id: "wki_renewal01", number: "WI-12" },
    });
    draw();
    const user = await openDialog();
    await user.type(
      screen.getByLabelText("Title"),
      "Show the renewal date on the billing page",
    );
    await user.type(
      screen.getByLabelText("Description"),
      "Owners ask when the plan renews.",
    );
    await user.type(screen.getByLabelText("Repository"), "a-intel/platform");
    await user.click(screen.getByTestId("work-new-item-submit"));
    expect(createWorkItem).toHaveBeenCalledWith("a-intel", "core-platform", {
      title: "Show the renewal date on the billing page",
      description: "Owners ask when the plan renews.",
      repository: "a-intel/platform",
    });
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(
        "/a-intel/core-platform/work/WI-12",
      );
    });
  });

  it("shows a refusal in the server's code and stays open", async () => {
    createWorkItem.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "work_forbidden",
    });
    draw();
    const user = await openDialog();
    await user.type(screen.getByLabelText("Title"), "Fix the export");
    await user.click(screen.getByTestId("work-new-item-submit"));
    expect(await screen.findByTestId("work-action-failure")).toHaveTextContent(
      "Your role cannot make this change in this workspace. Nothing changed.",
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("work-new-item-dialog")).toBeInTheDocument();
  });

  it("names a code it has no sentence for as recorded", async () => {
    createWorkItem.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "repository_unknown",
    });
    draw();
    const user = await openDialog();
    await user.type(screen.getByLabelText("Title"), "Fix the export");
    await user.click(screen.getByTestId("work-new-item-submit"));
    expect(await screen.findByTestId("work-action-failure")).toHaveTextContent(
      "oxagen refused the change with repository_unknown. Nothing changed.",
    );
  });

  it("refuses an empty title before anything is sent", async () => {
    draw();
    const user = await openDialog();
    await user.type(screen.getByLabelText("Title"), "   ");
    await user.click(screen.getByTestId("work-new-item-submit"));
    expect(screen.getByTestId("work-action-failure")).toHaveTextContent(
      "Write a title first.",
    );
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it("is disabled with its reason for a role that cannot enter work", () => {
    draw(false);
    const open = screen.getByTestId("work-new-item");
    expect(open).toBeDisabled();
    expect(open).toHaveAccessibleDescription(
      "Your role cannot enter work in this workspace.",
    );
  });
});
