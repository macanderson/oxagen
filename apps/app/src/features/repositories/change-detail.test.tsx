// @vitest-environment jsdom
// One Context PR on the Changes tab, over fake server actions: the read's
// three states, every fact the pull request can be missing, each check's
// sentence, the stopped run, and the lifecycle's two writes (merge and close)
// with their refusals and their throws.
//
// The actions are the seam; actions.test.ts proves them against the kernel.
// What is under test here is what the detail draws from their answers and
// which of them it calls.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryChange } from "@/data/contracts/repository";
import type { ContextPr } from "@/data/contracts/steering";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const actions = vi.hoisted(() => ({
  readRepositoryChange: vi.fn(),
  mergeRepositoryChange: vi.fn(),
  closeRepositoryChange: vi.fn(),
}));
vi.mock("./actions", () => actions);

vi.mock("next/link", () => ({
  default: ({
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      {...rest}
      onClick={(e) => {
        e.preventDefault(); // jsdom cannot navigate documents
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

const { ChangeDetail } = await import("./change-detail");

type Check = ContextPr["checks"][number];

const passed = (name: Check["name"]): Check => ({
  name,
  status: "passed",
  summary: `${name} held.`,
});

const ALL_PASSED: Check[] = [
  passed("schema"),
  passed("lineage_uniqueness"),
  passed("record_hash"),
  passed("secret_pii_scan"),
  passed("conflict_against_active"),
  passed("constraint_effect"),
];

const PR: ContextPr = {
  proposalId: "prp_open1",
  lineage: "ctx.scr.001-never-push-to-main",
  status: "checks_passed",
  governanceMode: "team",
  pr: {
    number: 42,
    url: "https://github.com/acme/platform/pull/42",
    repository: "acme/platform",
    baseRef: "main",
    branch: "context/ctx.scr.001-never-push-to-main",
    headSha: "0123456789abcdef",
  },
  body: null,
  checks: ALL_PASSED,
  onMerge: {
    path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
    bundleVersion: { current: 3, afterMerge: 4 },
  },
  merged: null,
};

const ROW: RepositoryChange = {
  proposalId: "prp_open1",
  lineage: "ctx.scr.001-never-push-to-main (row)",
  statement: "Never push to main",
  why: "Main is shared and contested.",
  kind: "context_record",
  pullRequest: {
    number: 42,
    url: "https://github.com/acme/platform/pull/42",
    repository: "acme/platform",
    branch: "context/ctx.scr.001-never-push-to-main",
  },
  openedBy: "the promoter",
  status: "checks_passed",
  checks: { passed: 6, total: 6 },
  openedAt: "2026-09-18T10:00:00.000Z",
};

const CLOSER = { name: "Mac Anderson", email: "mac@acme.test" };

const callbacks = {
  onBack: vi.fn(),
  onMergeable: vi.fn(),
  onChanged: vi.fn(),
};

function detail(row: RepositoryChange | null = ROW) {
  return render(
    <IntlProvider>
      <ChangeDetail
        org="acme"
        ws="core-platform"
        proposalId="prp_open1"
        row={row}
        closer={CLOSER}
        onBack={callbacks.onBack}
        onMergeable={callbacks.onMergeable}
        onChanged={callbacks.onChanged}
      />
    </IntlProvider>,
  );
}

/** Renders the detail and waits for the pull request's read to land. */
async function loaded(row: RepositoryChange | null = ROW) {
  const user = userEvent.setup();
  const view = detail(row);
  await screen.findByTestId("change-merge-steps");
  return { user, view, root: screen.getByTestId("change-detail") };
}

beforeEach(() => {
  for (const fn of [...Object.values(actions), ...Object.values(callbacks)])
    fn.mockReset();
  actions.readRepositoryChange.mockResolvedValue({ ok: true, value: PR });
});
afterEach(cleanup);

describe("reading the pull request", () => {
  it("says it is reading, titled by the list's row and in the row's state, until the read answers", async () => {
    let answer!: (value: unknown) => void;
    actions.readRepositoryChange.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    detail({ ...ROW, status: "checks_running" });
    expect(screen.getByTestId("change-loading")).toHaveTextContent(
      "Reading the pull request",
    );
    const root = screen.getByTestId("change-detail");
    expect(root.dataset.status).toBe("checks_running");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "ctx.scr.001-never-push-to-main (row)",
    );
    // No count is drawn before a check has been read.
    expect(root).not.toHaveTextContent("/ 6");
    expect(root.querySelector('[data-ci="running"]')).not.toBeNull();
    expect(actions.readRepositoryChange).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_open1",
    );
    await act(async () => {
      answer({ ok: true, value: PR });
      await Promise.resolve();
    });
    expect(await screen.findByTestId("change-merge-steps")).toBeTruthy();
    expect(root.dataset.status).toBe("checks_passed");
  });

  it("reads as open, titled by the proposal id, when neither the row nor the read has answered", () => {
    actions.readRepositoryChange.mockReturnValue(new Promise(() => {}));
    detail(null);
    const root = screen.getByTestId("change-detail");
    expect(root.dataset.status).toBe("pr_open");
    expect(screen.getByTestId("change-state")).toHaveTextContent("open");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "prp_open1",
    );
    expect(root.querySelector('[data-ci="queued"]')).not.toBeNull();
  });

  it("prints the read's refusal in place of the pull request (negative)", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "repository.read",
    });
    detail();
    expect(await screen.findByTestId("change-failure")).toHaveTextContent(
      "Only an organization Owner or Admin",
    );
    expect(screen.queryByTestId("change-merge")).toBeNull();
    expect(callbacks.onMergeable).not.toHaveBeenCalledWith(true);
  });

  it("names the call as unanswered when the read throws (negative)", async () => {
    actions.readRepositoryChange.mockRejectedValue(new Error("socket hang up"));
    detail();
    expect(await screen.findByTestId("change-failure")).toHaveTextContent(
      "action_failed",
    );
  });

  it("drops an answer that lands after the detail left the screen", async () => {
    let answer!: (value: unknown) => void;
    actions.readRepositoryChange.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const view = detail();
    view.unmount();
    await act(async () => {
      answer({ ok: true, value: PR });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("change-detail")).toBeNull();
    // Leaving hands the one gold back to the header.
    expect(callbacks.onMergeable).toHaveBeenLastCalledWith(false);
  });

  it("goes back to every change from its back button", async () => {
    const { user } = await loaded();
    await user.click(screen.getByTestId("change-back"));
    expect(callbacks.onBack).toHaveBeenCalledTimes(1);
  });
});

describe("the facts", () => {
  it("draws the kind, the pull request, its branch onto its base, the opener, the why and the file it carries", async () => {
    const { root } = await loaded();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "ctx.scr.001-never-push-to-main (row)",
    );
    expect(root).toHaveTextContent("context record");
    expect(root).toHaveTextContent(".oxagen/rules/<lineage>.toml");
    expect(screen.getByTestId("change-pr")).toHaveTextContent(
      "acme/platform#42",
    );
    expect(root).toHaveTextContent(
      "context/ctx.scr.001-never-push-to-main → main",
    );
    expect(root).toHaveTextContent("the promoter");
    expect(root).toHaveTextContent("Sep 18, 2026");
    expect(screen.getByTestId("change-why")).toHaveTextContent(
      "Main is shared and contested.",
    );
    expect(screen.getByTestId("change-files")).toHaveTextContent(
      ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
    );
    expect(screen.getByTestId("change-merge-steps")).toHaveTextContent(
      "from v3 to v4",
    );
    expect(root).toHaveTextContent("6 / 6");
    await expectNoAxe(root);
  });

  it("says a person opened it rather than printing their user id", async () => {
    const { root } = await loaded({ ...ROW, openedBy: "user:mac" });
    expect(root).toHaveTextContent("a person");
    expect(root).not.toHaveTextContent("user:mac");
  });

  it("says what is not recorded: no row, a blank why, and a proposal with no pull request yet (negative)", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: {
        ...PR,
        status: "proposed",
        pr: null,
        governanceMode: null,
        checks: [],
      },
    });
    const { root } = await loaded(null);
    // A proposal with no pull request reads as open, titled by its lineage.
    expect(root.dataset.status).toBe("pr_open");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "ctx.scr.001-never-push-to-main",
    );
    expect(screen.getByTestId("change-pr")).toHaveTextContent("not recorded");
    expect(screen.getByTestId("change-why")).toHaveTextContent("not recorded");
    expect(
      root.querySelectorAll('[data-state="not-recorded"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(root).toHaveTextContent("0 / 0");
    // Nothing to merge onto and no pull request to close.
    expect(screen.getByTestId("change-merge")).toBeDisabled();
    expect(screen.getByTestId("change-close")).toBeDisabled();
    expect(screen.queryByTestId("closepr-dialog")).toBeNull();
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Governance: not read yet",
    );

    cleanup();
    actions.readRepositoryChange.mockResolvedValue({ ok: true, value: PR });
    await loaded({ ...ROW, why: "   " });
    expect(screen.getByTestId("change-why")).toHaveTextContent("not recorded");
  });
});

describe("the checks", () => {
  it("stops the run at the failed check: the row says why, the checks behind it did not run, and merge is disabled", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: {
        ...PR,
        status: "checks_failed",
        checks: [
          passed("schema"),
          {
            name: "secret_pii_scan",
            status: "failed",
            summary: "An API key is in the statement.",
          },
          { name: "record_hash", status: "pending", summary: "" },
        ],
      },
    });
    const { root } = await loaded({ ...ROW, status: "checks_failed" });
    expect(root.querySelector('[data-ci="failed"]')).not.toBeNull();
    expect(root).toHaveTextContent("1 / 3");
    const table = screen.getByTestId("change-checks");
    const failedRow = within(table).getByText("secret_pii_scan").closest("tr");
    expect(failedRow).toHaveAttribute("data-result", "failed");
    expect(failedRow).toHaveTextContent("fail");
    const queued = table.querySelector('[data-check="record_hash"]');
    expect(queued).toHaveTextContent("queued");
    expect(queued).toHaveTextContent(
      "Did not run: secret_pii_scan stopped the run.",
    );
    expect(screen.getByTestId("change-stopped")).toHaveTextContent(
      "secret_pii_scan stopped the run. An API key is in the statement.",
    );
    expect(screen.getByTestId("change-merge")).toBeDisabled();
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Merge stays disabled until every check reports.",
    );
    expect(callbacks.onMergeable).not.toHaveBeenCalledWith(true);
  });

  it("says a running check has not reported yet, and waits on it before merge", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: {
        ...PR,
        status: "checks_running",
        checks: [
          passed("schema"),
          { name: "record_hash", status: "running", summary: "" },
        ],
      },
    });
    await loaded();
    const running = screen
      .getByTestId("change-checks")
      .querySelector('[data-check="record_hash"]');
    expect(running).toHaveTextContent("running");
    expect(running).toHaveTextContent("not reported yet");
    expect(screen.queryByTestId("change-stopped")).toBeNull();
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Merge stays disabled until every check reports.",
    );
  });
});

describe("merge", () => {
  it("is the gold action only when every check passed, and merging re-reads and tells the list", async () => {
    const { user, root } = await loaded();
    const merge = screen.getByTestId("change-merge");
    expect(merge).toBeEnabled();
    expect(merge.className).toContain("bg-button-primary-bg");
    expect(callbacks.onMergeable).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Governance: team on GitHub",
    );

    let settle!: (value: unknown) => void;
    actions.mergeRepositoryChange.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: {
        ...PR,
        status: "merged",
        merged: {
          commit: "fedcba9876543210",
          at: "2026-09-19T10:00:00.000Z",
          promotionEventId: "pev_1",
          recordId: "rec_1",
        },
      },
    });
    await user.click(merge);
    expect(merge).toHaveTextContent("Merging");
    expect(merge).toBeDisabled();
    await act(async () => {
      settle({ ok: true, value: { commit: "fedcba9876543210" } });
      await Promise.resolve();
    });
    expect(await screen.findByTestId("change-done")).toHaveTextContent(
      "Merged at fedcba9.",
    );
    expect(await screen.findByTestId("change-merged")).toHaveTextContent(
      "The file is on main",
    );
    expect(actions.mergeRepositoryChange).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_open1",
    );
    expect(actions.readRepositoryChange).toHaveBeenCalledTimes(2);
    expect(callbacks.onChanged).toHaveBeenCalledTimes(1);
    // A merged pull request offers neither merge nor close.
    expect(screen.queryByTestId("change-merge")).toBeNull();
    expect(screen.queryByTestId("change-close")).toBeNull();
    expect(root.dataset.status).toBe("merged");
    expect(callbacks.onMergeable).toHaveBeenLastCalledWith(false);
  });

  it("prints the handler's refusal and keeps the pull request open (negative)", async () => {
    actions.mergeRepositoryChange.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "checks_not_passed",
    });
    const { user } = await loaded();
    await user.click(screen.getByTestId("change-merge"));
    expect(await screen.findByTestId("change-merge-failure")).toHaveTextContent(
      "This was refused: checks_not_passed.",
    );
    expect(screen.getByTestId("change-merge")).toBeEnabled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(actions.readRepositoryChange).toHaveBeenCalledTimes(1);
  });

  it("names the call as unanswered when merge throws (negative)", async () => {
    actions.mergeRepositoryChange.mockRejectedValue(new Error("offline"));
    const { user } = await loaded();
    await user.click(screen.getByTestId("change-merge"));
    expect(await screen.findByTestId("change-merge-failure")).toHaveTextContent(
      "action_failed",
    );
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });

  it("draws no merge or close on a pull request that was closed", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: { ...PR, status: "rejected" },
    });
    const { root } = await loaded({ ...ROW, status: "rejected" });
    expect(root.dataset.status).toBe("rejected");
    expect(screen.getByTestId("change-state")).toHaveTextContent("closed");
    expect(screen.queryByTestId("change-merge")).toBeNull();
    expect(screen.queryByTestId("change-merged")).toBeNull();
  });
});

describe("close", () => {
  async function openClose() {
    const ctx = await loaded();
    await ctx.user.click(screen.getByTestId("change-close"));
    const dialog = await screen.findByTestId("closepr-dialog");
    return { ...ctx, dialog };
  }

  it("previews the comment that names the closer and links back to this change, and closes with it", async () => {
    actions.closeRepositoryChange.mockResolvedValue({
      ok: true,
      value: { status: "rejected" },
    });
    const { user, dialog } = await openClose();
    expect(dialog).toHaveTextContent("Close acme/platform#42");
    const comment = within(dialog).getByTestId("closepr-comment");
    expect(comment).toHaveTextContent("Closed by Mac Anderson <mac@acme.test>");
    const link = within(dialog).getByTestId("closepr-link");
    expect(link).toHaveAttribute(
      "href",
      "/acme/core-platform/repositories/changes/prp_open1",
    );
    // The comment carries the absolute URL, since it is read on GitHub.
    expect(link.textContent).toMatch(
      /^https?:\/\/.+\/acme\/core-platform\/repositories\/changes\/prp_open1$/,
    );
    expect(dialog).toHaveTextContent("GitHub shows no comment");
    await expectNoAxe(dialog);

    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: { ...PR, status: "rejected" },
    });
    await user.click(within(dialog).getByTestId("closepr-submit"));
    expect(await screen.findByTestId("change-done")).toHaveTextContent(
      "Closed without merging.",
    );
    expect(actions.closeRepositoryChange).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_open1",
      expect.stringMatching(
        /^Closed by Mac Anderson <mac@acme\.test>\n\n---\n\nAdded via Oxagen \[https?:\/\/[^\]]+\/acme\/core-platform\/repositories\/changes\/prp_open1\]\(/,
      ),
    );
    expect(callbacks.onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("closepr-dialog")).toBeNull();
    });
    expect(await screen.findByTestId("change-state")).toHaveTextContent(
      "closed",
    );
  });

  it("prints the refusal in the dialog and keeps it open; cancelling clears it (negative)", async () => {
    actions.closeRepositoryChange.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    const { user, dialog } = await openClose();
    await user.click(within(dialog).getByTestId("closepr-submit"));
    expect(
      await within(dialog).findByTestId("closepr-failure"),
    ).toHaveTextContent("Only an organization Owner or Admin");
    expect(callbacks.onChanged).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("closepr-dialog")).toBeNull();
    });
    await user.click(screen.getByTestId("change-close"));
    const reopened = await screen.findByTestId("closepr-dialog");
    expect(within(reopened).queryByTestId("closepr-failure")).toBeNull();
  });

  it("names the call as unanswered when close throws, and says it is closing while it waits (negative)", async () => {
    let fail!: (reason: unknown) => void;
    actions.closeRepositoryChange.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { user, dialog } = await openClose();
    const submit = within(dialog).getByTestId("closepr-submit");
    await user.click(submit);
    expect(submit).toHaveTextContent("Closing");
    expect(submit).toBeDisabled();
    await act(async () => {
      fail(new Error("offline"));
      await Promise.resolve();
    });
    expect(
      await within(dialog).findByTestId("closepr-failure"),
    ).toHaveTextContent("action_failed");
    expect(submit).toBeEnabled();
  });
});
