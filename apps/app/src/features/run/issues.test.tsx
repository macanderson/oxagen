// @vitest-environment jsdom
// The Issues tab's table (#4024): the run's task reference, then the issues
// its own pull requests close by GitHub's record. A pull request matched by
// branch name is a guess and adds nothing, and a list GitHub did not return
// never reads as closing nothing.
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunWork } from "@/data/contracts/run-work";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runOutputs, runRow, runWork } from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { closingIssuesOf, IssuesSection } = await import("./issues");

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };

type Pull = RunWork["pullRequests"][number];

const base = runWork().pullRequests[0];
if (base === undefined) throw new Error("the builder names one pull request");

const issue = (number: number) => ({
  owner: "acme",
  repo: "platform",
  number,
  title: `Issue ${String(number)}`,
  url: `https://github.com/acme/platform/issues/${String(number)}`,
  state: "open" as const,
});

const pull = (
  number: number,
  association: Pull["association"],
  closingIssues: Pull["closingIssues"],
): Pull => ({
  ...base,
  number,
  url: `${base.repository.url}/pull/${String(number)}`,
  association,
  closingIssues,
});

function renderIssues(taskRef: string | null, work: Read<RunWork> | null) {
  return render(
    <IntlProvider>
      <IssuesSection
        run={runRow({ taskRef })}
        outputs={readOk(runOutputs())}
        work={work}
        place={PLACE}
      />
    </IntlProvider>,
  );
}

const table = () => screen.getByRole("table", { name: "Issues" });

describe("the Issues table", () => {
  it("lists the issues a recorded pull request closes and ignores a branch match", async () => {
    const { container } = renderIssues(
      "acme/platform#1",
      readOk(
        runWork({
          pullRequests: [
            pull(42, "recorded", { issues: [issue(7)], complete: true }),
            pull(43, "branch", { issues: [issue(9)], complete: true }),
          ],
        }),
      ),
    );
    const rows = within(table()).getAllByTestId("run-issue-row");
    expect(rows).toHaveLength(2);
    const closing = rows[1];
    if (closing === undefined) throw new Error("the closing row renders");
    expect(closing).toHaveTextContent("acme/platform#7");
    expect(closing).toHaveTextContent("Issue 7");
    expect(closing).toHaveTextContent("closes");
    expect(closing).toHaveTextContent("by pull request #42");
    expect(closing).toHaveTextContent("observed");
    expect(
      within(closing).getByRole("link", { name: "View ↗" }),
    ).toHaveAttribute("href", "https://github.com/acme/platform/issues/7");
    expect(screen.queryByText("acme/platform#9")).toBeNull();
    expect(screen.getByText("2 in this session")).toBeInTheDocument();
    await expectNoAxe(container);
  });

  it("lists a closed issue once when it is also the task reference", () => {
    renderIssues(
      "acme/platform#7",
      readOk(
        runWork({
          pullRequests: [
            pull(42, "recorded", { issues: [issue(7)], complete: true }),
          ],
        }),
      ),
    );
    expect(within(table()).getAllByTestId("run-issue-row")).toHaveLength(1);
  });

  it("says GitHub's list was not read instead of saying no pull request closes an issue", () => {
    renderIssues(
      null,
      readOk(runWork({ pullRequests: [pull(42, "recorded", null)] })),
    );
    expect(
      screen.getByText(/GitHub did not return the issues/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no pull request it opened/)).toBeNull();
  });

  it("names no issue when the task reference is empty and every list was read", () => {
    renderIssues(null, readOk(runWork()));
    expect(
      screen.getByText(
        "No issue is linked to this session, and no pull request it opened closes one.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the task reference and says the list may be short when the work read fails", () => {
    renderIssues("acme/platform#1", readError("unavailable", 503));
    expect(within(table()).getAllByTestId("run-issue-row")).toHaveLength(1);
    expect(screen.getByText(/so this list may be short/)).toBeInTheDocument();
  });
});

describe("closingIssuesOf", () => {
  it("is null when the page did not read the work", () => {
    expect(closingIssuesOf(null)).toBeNull();
  });

  it("marks a list GitHub cut short as unread and keeps what it returned", () => {
    const result = closingIssuesOf(
      readOk(
        runWork({
          pullRequests: [
            pull(42, "recorded", { issues: [issue(7)], complete: false }),
            pull(44, "recorded", { issues: [issue(7)], complete: true }),
          ],
        }),
      ),
    );
    expect(result?.unread).toBe(true);
    expect(result?.issues.map((row) => [row.number, row.pr])).toEqual([
      [7, 42],
    ]);
  });
});
