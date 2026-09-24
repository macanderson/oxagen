// @vitest-environment jsdom
// One Context PR on the Changes tab over fake server actions: every state the
// detail can be in (loading, refused, loaded with checks passed, failed,
// running or merged, and a proposal with no pull request yet), Merge and its
// refusal, and Close with the comment it previews. The actions are proven
// against the kernel seam in actions.test.ts; here they answer the way the
// capabilities answer, so what is under test is the page.
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
import type { closeRepositoryChange } from "./actions";

const actions = vi.hoisted(() => ({
  readRepositoryChange: vi.fn(),
  mergeRepositoryChange: vi.fn(),
  closeRepositoryChange: vi.fn<typeof closeRepositoryChange>(),
}));
vi.mock("./actions", () => actions);

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform/repositories/changes/prp_open1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
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

const PASSED: ContextPr = {
  proposalId: "prp_open1",
  lineage: "ctx.scr.001-never-push-to-main",
  status: "checks_passed",
  governanceMode: "team",
  pr: {
    number: 42,
    url: "https://github.com/acme/platform/pull/42",
    repository: "acme/platform",
    baseRef: "main",
    branch: "oxagen/prp_open1",
    headSha: "0123456789abcdef",
  },
  body: null,
  checks: [
    { name: "schema", status: "passed", summary: "The record parses." },
    { name: "record_hash", status: "passed", summary: "" },
  ],
  onMerge: {
    path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
    bundleVersion: { current: 7, afterMerge: 8 },
  },
  merged: null,
};

const FAILED: ContextPr = {
  ...PASSED,
  status: "checks_failed",
  checks: [
    { name: "schema", status: "passed", summary: "The record parses." },
    {
      name: "secret_pii_scan",
      status: "failed",
      summary: "Line 4 carries an email address.",
    },
    { name: "conflict_against_active", status: "pending", summary: "" },
  ],
};

const ROW: RepositoryChange = {
  proposalId: "prp_open1",
  lineage: "ctx.scr.001-never-push-to-main",
  statement: "Never push to main",
  why: "Main is shared and contested.",
  kind: "context_record",
  pullRequest: {
    number: 42,
    url: "https://github.com/acme/platform/pull/42",
    repository: "acme/platform",
    branch: "oxagen/prp_open1",
  },
  openedBy: "user:mac",
  status: "checks_passed",
  checks: { passed: 2, total: 2 },
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

async function loaded(pr: ContextPr, row: RepositoryChange | null = ROW) {
  actions.readRepositoryChange.mockResolvedValue({ ok: true, value: pr });
  const user = userEvent.setup();
  detail(row);
  await screen.findByTestId("change-checks");
  return user;
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(callbacks)) fn.mockReset();
});
afterEach(cleanup);

describe("reading the pull request", () => {
  it("says it is reading, then draws the facts, the file, the checks and what merge will do", async () => {
    let answer!: (value: unknown) => void;
    actions.readRepositoryChange.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    detail();
    expect(screen.getByTestId("change-loading")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "ctx.scr.001-never-push-to-main",
    );
    answer({ ok: true, value: PASSED });
    const checks = await screen.findByTestId("change-checks");
    expect(actions.readRepositoryChange).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_open1",
    );
    expect(screen.getByTestId("change-pr")).toHaveTextContent(
      "acme/platform#42",
    );
    const root = screen.getByTestId("change-detail");
    expect(root).toHaveTextContent("oxagen/prp_open1 → main");
    // The kind's path names its placeholder literally, not as markup.
    expect(root).toHaveTextContent(".oxagen/rules/<lineage>.toml");
    // A person's user id is said as a person, with when they opened it.
    expect(root).toHaveTextContent("a person");
    expect(screen.getByTestId("change-why")).toHaveTextContent(
      "Main is shared and contested.",
    );
    expect(screen.getByTestId("change-files")).toHaveTextContent(
      ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
    );
    expect(
      within(checks)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual([
      "schemapassThe record parses.",
      "record_hashpassnot reported yet",
    ]);
    expect(screen.getByTestId("change-merge-steps")).toHaveTextContent(
      "bump the workspace bundle version from v7 to v8",
    );
    expect(screen.getByTestId("change-state")).toHaveTextContent(
      "checks passed",
    );
    expect(root).toHaveTextContent("2 / 2");
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Governance: team on GitHub",
    );
    await expectNoAxe(root);
  });

  it("prints a refusal to read, and no facts (negative)", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "proposal_not_found",
    });
    detail();
    expect(await screen.findByTestId("change-failure")).toHaveTextContent(
      "proposal_not_found",
    );
    expect(screen.queryByTestId("change-checks")).toBeNull();
  });

  it("reads an unanswered action as a failure rather than hanging (negative)", async () => {
    actions.readRepositoryChange.mockRejectedValue(new Error("network"));
    detail();
    expect(await screen.findByTestId("change-failure")).toBeTruthy();
  });

  it("says what is not recorded when the list holds no row for the change", async () => {
    await loaded({ ...PASSED, governanceMode: null }, null);
    const root = screen.getByTestId("change-detail");
    expect(screen.getByTestId("change-why")).toHaveTextContent("not recorded");
    expect(
      root.querySelectorAll('[data-state="not-recorded"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Governance: not read yet",
    );
  });

  it("prints a source that is not a person as recorded", async () => {
    await loaded(PASSED, { ...ROW, openedBy: "the promoter", why: "  " });
    const root = screen.getByTestId("change-detail");
    expect(root).toHaveTextContent("the promoter");
    expect(screen.getByTestId("change-why")).toHaveTextContent("not recorded");
  });

  it("reads a proposal with no pull request yet as open, with nothing to close", async () => {
    await loaded({ ...PASSED, status: "proposed", pr: null, checks: [] }, null);
    expect(screen.getByTestId("change-state")).toHaveTextContent("open");
    expect(screen.getByTestId("change-pr")).toHaveTextContent("not recorded");
    expect(screen.getByTestId("change-merge")).toBeDisabled();
    expect(screen.getByTestId("change-close")).toBeDisabled();
    expect(screen.queryByTestId("closepr-dialog")).toBeNull();
  });

  it("drops an answer that lands after the detail left the screen, and hands the gold back", async () => {
    let answer!: (value: unknown) => void;
    actions.readRepositoryChange.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const view = detail();
    view.unmount();
    await act(async () => {
      answer({ ok: true, value: PASSED });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("change-detail")).toBeNull();
    expect(callbacks.onMergeable).not.toHaveBeenCalledWith(true);
    expect(callbacks.onMergeable).toHaveBeenLastCalledWith(false);
  });

  it("goes back to every change", async () => {
    const user = await loaded(PASSED);
    await user.click(screen.getByTestId("change-back"));
    expect(callbacks.onBack).toHaveBeenCalledOnce();
  });
});

describe("a failed check", () => {
  it("stops the run where it stopped, says why, and keeps Merge disabled (negative)", async () => {
    const user = await loaded(FAILED);
    expect(screen.getByTestId("change-stopped")).toHaveTextContent(
      "secret_pii_scan stopped the run. Line 4 carries an email address.",
    );
    const pending = screen
      .getByTestId("change-checks")
      .querySelector('[data-check="conflict_against_active"]');
    expect(pending).toHaveTextContent(
      "Did not run: secret_pii_scan stopped the run.",
    );
    const merge = screen.getByTestId("change-merge");
    expect(merge).toBeDisabled();
    expect(merge.className).not.toContain("bg-button-primary-bg");
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Merge stays disabled until every check reports.",
    );
    await user.click(merge);
    expect(actions.mergeRepositoryChange).not.toHaveBeenCalled();
    expect(callbacks.onMergeable).not.toHaveBeenCalledWith(true);
  });

  it("waits while a check is still running", async () => {
    await loaded({
      ...PASSED,
      status: "checks_running",
      checks: [{ name: "schema", status: "running", summary: "" }],
    });
    expect(screen.getByTestId("change-merge")).toBeDisabled();
    expect(screen.queryByTestId("change-stopped")).toBeNull();
    expect(screen.getByTestId("change-governance")).toHaveTextContent(
      "Merge stays disabled until every check reports.",
    );
  });
});

describe("merging", () => {
  it("merges a pull request whose every check passed, then re-reads it", async () => {
    const user = await loaded(PASSED);
    await waitFor(() => {
      expect(callbacks.onMergeable).toHaveBeenLastCalledWith(true);
    });
    const merge = screen.getByTestId("change-merge");
    expect(merge.className).toContain("bg-button-primary-bg");
    actions.mergeRepositoryChange.mockResolvedValue({
      ok: true,
      value: { commit: "fedcba9876543210" },
    });
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: {
        ...PASSED,
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
    expect(await screen.findByTestId("change-done")).toHaveTextContent(
      "Merged at fedcba9.",
    );
    expect(actions.mergeRepositoryChange).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_open1",
    );
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("change-merged")).toHaveTextContent(
      "The file is on main",
    );
    expect(actions.readRepositoryChange).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("change-merge")).toBeNull();
  });

  it("prints a merge refusal and writes nothing else (negative)", async () => {
    const user = await loaded(PASSED);
    actions.mergeRepositoryChange.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "head_moved",
    });
    await user.click(screen.getByTestId("change-merge"));
    expect(await screen.findByTestId("change-merge-failure")).toHaveTextContent(
      "head_moved",
    );
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });

  it("reads a merge that never answered as a failure (negative)", async () => {
    const user = await loaded(PASSED);
    actions.mergeRepositoryChange.mockRejectedValue(new Error("network"));
    await user.click(screen.getByTestId("change-merge"));
    expect(await screen.findByTestId("change-merge-failure")).toBeTruthy();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });

  it("offers neither Merge nor Close once a pull request was closed", async () => {
    await loaded({ ...PASSED, status: "rejected" });
    expect(screen.queryByTestId("change-merge")).toBeNull();
    expect(screen.queryByTestId("change-close")).toBeNull();
  });
});

describe("closing without merging", () => {
  it("previews the comment with the closer and this page's URL, and closes", async () => {
    const user = await loaded(FAILED);
    await user.click(screen.getByTestId("change-close"));
    const dialog = await screen.findByTestId("closepr-dialog");
    expect(dialog).toHaveTextContent("Close acme/platform#42");
    const comment = within(dialog).getByTestId("closepr-comment");
    expect(comment).toHaveTextContent("Closed by Mac Anderson <mac@acme.test>");
    expect(within(comment).getByTestId("closepr-link")).toHaveAttribute(
      "href",
      "/acme/core-platform/repositories/changes/prp_open1",
    );
    await expectNoAxe(dialog);
    actions.closeRepositoryChange.mockResolvedValue({
      ok: true,
      value: { status: "rejected" },
    });
    await user.click(within(dialog).getByTestId("closepr-submit"));
    await waitFor(() => {
      expect(actions.closeRepositoryChange).toHaveBeenCalledOnce();
    });
    const call: readonly unknown[] =
      actions.closeRepositoryChange.mock.calls[0] ?? [];
    const [org, ws, proposalId, sent] = call;
    expect([org, ws, proposalId]).toEqual([
      "acme",
      "core-platform",
      "prp_open1",
    ]);
    expect(sent).toContain("Closed by Mac Anderson <mac@acme.test>");
    expect(sent).toContain(
      "/acme/core-platform/repositories/changes/prp_open1",
    );
    expect(await screen.findByTestId("change-done")).toHaveTextContent(
      "Closed without merging.",
    );
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
  });

  it("prints a close refusal in the dialog and keeps it open (negative)", async () => {
    const user = await loaded(FAILED);
    await user.click(screen.getByTestId("change-close"));
    const dialog = await screen.findByTestId("closepr-dialog");
    actions.closeRepositoryChange.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    await user.click(within(dialog).getByTestId("closepr-submit"));
    expect(
      await within(dialog).findByTestId("closepr-failure"),
    ).toHaveTextContent("Only an organization Owner or Admin");
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });

  it("reads a close that never answered as a failure, and Cancel dismisses (negative)", async () => {
    const user = await loaded(FAILED);
    await user.click(screen.getByTestId("change-close"));
    const dialog = await screen.findByTestId("closepr-dialog");
    actions.closeRepositoryChange.mockRejectedValue(new Error("network"));
    await user.click(within(dialog).getByTestId("closepr-submit"));
    expect(await within(dialog).findByTestId("closepr-failure")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("closepr-dialog")).toBeNull();
    });
  });
});
