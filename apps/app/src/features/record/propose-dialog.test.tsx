// @vitest-environment jsdom
// Propose a change, on its own: a diff that keeps unchanged lines as
// context, a proposal whose pull request has not opened yet, a workspace
// whose repository could not be read, a write that throws, and Cancel, which
// forgets the refusal it showed.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const revise = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ reviseRecord: revise }));

const { ProposeDialog } = await import("./propose-dialog");

const LINEAGE = "ctx.scr.001-never-push-to-main";
const BASE = "Never push to main.\nOpen a pull request.";
const DRAFT = "Never push to main.\nOpen a pull request.\nWait for review.";

const onOpened = vi.fn();

function Harness({ repository }: { repository: string | null }) {
  const [open, setOpen] = useState(true);
  return (
    <IntlProvider>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        reopen
      </button>
      <ProposeDialog
        open={open}
        onOpenChange={setOpen}
        at={{ org: "acme", ws: "core-platform", lineage: LINEAGE }}
        path={`.oxagen/rules/${LINEAGE}.toml`}
        repository={repository}
        base={BASE}
        draft={DRAFT}
        constraintEffect={null}
        canWrite
        pendingBranch={null}
        onOpened={onOpened}
      />
    </IntlProvider>
  );
}

beforeEach(() => {
  revise.mockReset();
  onOpened.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Propose a change", () => {
  it("keeps unchanged lines as context in the diff, with no repository badge when none was read", async () => {
    render(<Harness repository={null} />);
    const diff = screen.getByTestId("record-diff");
    expect(screen.getByTestId("record-diff-stat")).toHaveTextContent("+1 −0");
    const sides = Array.from(diff.querySelectorAll("[data-side]")).map((row) =>
      row.getAttribute("data-side"),
    );
    expect(sides).toEqual(["ctx", "ctx", "add"]);
    expect(diff).not.toHaveTextContent("acme/platform");
    expect(diff).toHaveTextContent(`context/${LINEAGE}`);
    expect(screen.getByTestId("record-propose")).toHaveTextContent(
      "constraint_effect",
    );
    await expectNoAxe(screen.getByTestId("record-propose"));
  });

  it("says the proposal is raised when its pull request has not opened yet", async () => {
    revise.mockResolvedValue({
      ok: true,
      value: { status: "proposed", prNumber: null, prUrl: null },
    });
    const user = userEvent.setup();
    render(<Harness repository={null} />);
    await user.click(screen.getByTestId("record-propose-submit"));
    const done = await screen.findByTestId("record-propose-done");
    expect(done).toHaveTextContent(
      `The proposal is raised. ${LINEAGE} changes when its pull request merges`,
    );
    expect(done).toHaveTextContent(
      "The proposal is raised and its pull request has not opened yet.",
    );
    expect(onOpened).toHaveBeenCalledWith(`context/${LINEAGE}`);
    expect(screen.queryByTestId("record-propose-submit")).toBeNull();
    await expectNoAxe(screen.getByTestId("record-propose"));
  });

  it("numbers the pull request without a repository it could not read", async () => {
    revise.mockResolvedValue({
      ok: true,
      value: { status: "pr_open", prNumber: 528, prUrl: null },
    });
    const user = userEvent.setup();
    render(<Harness repository={null} />);
    await user.click(screen.getByTestId("record-propose-submit"));
    expect(await screen.findByTestId("record-propose-done")).toHaveTextContent(
      `#528 opened. ${LINEAGE} changes when it merges`,
    );
  });

  it("says it is opening while it waits, then names the call as unanswered when it throws (negative)", async () => {
    let fail!: (reason: unknown) => void;
    revise.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    render(<Harness repository="acme/platform" />);
    const submit = screen.getByTestId("record-propose-submit");
    await user.click(submit);
    expect(submit).toHaveTextContent("Opening");
    expect(submit).toBeDisabled();
    await act(async () => {
      fail(new Error("offline"));
      await Promise.resolve();
    });
    expect(
      await screen.findByTestId("record-propose-failure"),
    ).toHaveTextContent(
      "Oxagen could not open the pull request: action_failed.",
    );
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("forgets the refusal once cancelled (negative)", async () => {
    revise.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "github_refused",
    });
    const user = userEvent.setup();
    render(<Harness repository="acme/platform" />);
    await user.click(screen.getByTestId("record-propose-submit"));
    const dialog = screen.getByTestId("record-propose");
    expect(
      await within(dialog).findByTestId("record-propose-failure"),
    ).toHaveTextContent("GitHub refused the write.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("record-propose")).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "reopen" }));
    expect(
      within(await screen.findByTestId("record-propose")).queryByTestId(
        "record-propose-failure",
      ),
    ).toBeNull();
  });
});
