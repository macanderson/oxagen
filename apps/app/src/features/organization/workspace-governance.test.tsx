// @vitest-environment jsdom
// The governance control in Organization › Workspaces › Edit workspace: the
// `wsGov` mode select, the override checkbox, and what the dialog does with each answer
// `set_governance_mode` can give.
//
// Four behaviours are load-bearing and each is asserted here rather than left
// to reading:
//
//   1. Untouched, the edit sends no mode, so a plain rename invokes no
//      governance capability and reaches no GitHub.
//   2. The override cannot be ticked until a mode is picked — a live checkbox
//      over a form that will change nothing is a lie about what Save does.
//   3. A `proposed` answer holds the dialog open with the pull request link.
//      That link is the whole point: the mode has not moved until someone
//      merges it, and the person cannot reconstruct the URL.
//   4. A refused governance change still reports the rename that succeeded.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/data/contracts/org";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  editWorkspace: vi.fn(),
}));

const { editWorkspace } = await import("./actions");
const { EditWorkspace } = await import("./workspace-actions");

const workspace: Workspace = {
  id: "ws_7a000000000000000000000001",
  name: "Platform",
  slug: "platform",
  namespace: "platform",
  role: "Admin",
  archivedAt: null,
  costCenter: null,
};

const edited = vi.mocked(editWorkspace);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the Edit workspace dialog and answers with `value`. */
async function openDialog(
  value: Awaited<ReturnType<typeof editWorkspace>> = {
    ok: true,
    value: { slug: "platform", governance: null },
  },
) {
  edited.mockResolvedValue(value);
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <EditWorkspace org="acme" workspace={workspace} />
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Edit" }));
  return user;
}

/** The draft the dialog sent on its one call. */
function sentDraft() {
  expect(edited).toHaveBeenCalledTimes(1);
  return edited.mock.calls[0]?.[2];
}

describe("EditWorkspace governance", () => {
  it("leaves the mode alone unless one is picked", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(edited).toHaveBeenCalled();
    });
    // Empty, which `editWorkspace` reads as "do not invoke
    // set_governance_mode" — no commit, no GitHub round trip.
    expect(sentDraft()?.mode).toBe("");
    expect(sentDraft()?.applyImmediately).toBe(false);
  });

  it("only offers the override once a mode is picked", async () => {
    const user = await openDialog();
    const override = screen.getByRole("checkbox", {
      name: /Apply now, without review/,
    });
    expect(override).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText("Governance mode"),
      "regulated",
    );
    expect(override).toBeEnabled();
    await user.click(override);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(edited).toHaveBeenCalled();
    });
    expect(sentDraft()?.mode).toBe("regulated");
    expect(sentDraft()?.applyImmediately).toBe(true);
  });

  it("holds the dialog open on a proposal and names the pull request", async () => {
    const user = await openDialog({
      ok: true,
      value: {
        slug: "platform",
        governance: {
          ok: true,
          outcome: "proposed",
          mode: "solo",
          repo: "acme/platform",
          branch: "main",
          pullRequest: {
            number: 412,
            htmlUrl: "https://github.com/acme/platform/pull/412",
            reused: false,
          },
          overrodeReview: false,
        },
      },
    });
    await user.selectOptions(screen.getByLabelText("Governance mode"), "solo");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const link = await screen.findByRole("link", {
      name: "Open pull request #412",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/pull/412",
    );
    // Still open, and nothing navigated away from the link.
    expect(replace).not.toHaveBeenCalled();
    await expectNoAxe(document.body);

    // "Done", not "Close": the dialog frame already has a Close affordance,
    // and dismissing the panel is the same act either way.
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
  });

  it("says the review was skipped when it was", async () => {
    const user = await openDialog({
      ok: true,
      value: {
        slug: "platform",
        governance: {
          ok: true,
          outcome: "applied",
          mode: "solo",
          repo: "acme/platform",
          branch: "main",
          pullRequest: null,
          overrodeReview: true,
        },
      },
    });
    await user.selectOptions(screen.getByLabelText("Governance mode"), "solo");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/steering\.governance_overridden/),
    ).toBeInTheDocument();
  });

  it("reports a refused governance change without disowning the rename", async () => {
    const user = await openDialog({
      ok: true,
      value: {
        slug: "platform",
        governance: {
          ok: false,
          reason: "conflict",
          code: "github_not_connected",
        },
      },
    });
    await user.selectOptions(screen.getByLabelText("Governance mode"), "team");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // "The name was saved. The governance mode was not changed: …" — both
    // halves, because both happened.
    expect(await screen.findByText(/The name was saved\./)).toBeInTheDocument();
    expect(screen.getByText(/github_not_connected/)).toBeInTheDocument();
  });

  it("closes without a panel when the file already said so", async () => {
    const user = await openDialog({
      ok: true,
      value: {
        slug: "platform",
        governance: {
          ok: true,
          outcome: "unchanged",
          mode: "team",
          repo: "acme/platform",
          branch: "main",
          pullRequest: null,
          overrodeReview: false,
        },
      },
    });
    await user.selectOptions(screen.getByLabelText("Governance mode"), "team");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // Nothing to read, so it behaves like every other write: close and reload.
    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
