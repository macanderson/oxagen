// @vitest-environment jsdom
// The Policy and Context tabs: each lists the entries of its own chip, links a
// frame on the run's own chain, names a subagent's frame without a link (the
// Frames tab reads the run's chain, where that seq is a different frame), and
// says the list is a prefix whenever another page lies past it. Policy leads
// with Oxagen and operator decisions and folds the harness's checks away.
import type { ReactNode } from "react";
import type { RunWork } from "@/data/contracts/run-work";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runTranscript, transcriptEntry } from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { ContextSection, IssuesList, PolicySection } = await import("./sections");

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const AT = "2026-09-23T12:00:00.000Z";

const policyEntry = (seq: string, chainRef?: string) =>
  transcriptEntry({
    seq,
    endSeq: seq,
    type: "policy_decision",
    kind: "frame",
    kinds: ["policy"],
    label: `deny Bash`,
    decision: {
      seq,
      ...(chainRef === undefined ? {} : { chainRef }),
      decision: "deny",
      type: "policy_decision",
      at: AT,
    },
    ...(chainRef === undefined
      ? {}
      : { subagent: { chainRef, type: "Explore" } }),
  });

/** A decision with a recorded source and outcome, on the run's own chain. */
const sourcedEntry = (
  seq: string,
  source: string | null,
  decision: string,
  type = "policy_decision",
) =>
  transcriptEntry({
    seq,
    endSeq: seq,
    type,
    kind: "frame",
    kinds: ["policy"],
    label: `${decision} Bash`,
    decision: { seq, decision, type, source, at: AT },
  });

const recallEntry = (seq: string, chainRef?: string) =>
  transcriptEntry({
    seq,
    endSeq: seq,
    type: "context.assembled",
    kind: "frame",
    kinds: ["recall"],
    label: "rows=3",
    decision: null,
    ...(chainRef === undefined
      ? {}
      : { subagent: { chainRef, type: "Explore" } }),
  });

describe("PolicySection", () => {
  it("links the run's own decision, names a subagent's without a link, and says nothing is cut when the read is whole", async () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [policyEntry("4"), policyEntry("4", CHAIN)],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const [own, subagent] = rows;
    if (own === undefined || subagent === undefined)
      throw new Error("expected two rows");
    expect(within(own).queryByRole("link")).not.toBeNull();
    expect(within(subagent).queryByRole("link")).toBeNull();
    expect(rows[1]?.textContent).toContain("4");
    expect(screen.queryByText(/prefix|first|cut/i)).toBeNull();
    await expectNoAxe(container);
  });

  it("says the list is a prefix when another page lies past it", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [policyEntry("4")],
              cursor: "t:4",
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.querySelector("p.pt-3")).not.toBeNull();
  });

  it("shows the read failure instead of a list", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readError("frame_store_unreachable", 502)}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.querySelector("table")).toBeNull();
  });
});

// Oxagen policy and operator decisions lead, and the harness's own
// permission checks fold below them (#4023).
describe("PolicySection by who decided", () => {
  it("lists Oxagen and operator decisions and folds harness checks away", async () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [
                sourcedEntry("2", "harness", "allow"),
                sourcedEntry("3", "bundle", "deny"),
                sourcedEntry("4", "managed_settings", "allow"),
                sourcedEntry("5", "human", "pause", "oxagen:command_applied"),
              ],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    const lead = screen.getByRole("table", { name: "Policy decisions" });
    const rows = within(lead).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Oxagen policy"),
      expect.stringContaining("Operator"),
    ]);
    expect(rows[1]?.textContent).toContain("pause");
    expect(rows[1]?.textContent).toContain("oxagen:command_applied");
    const checks = screen.getByTestId("harness-checks");
    expect(checks).not.toHaveAttribute("open");
    expect(checks.querySelector("summary")?.textContent).toBe(
      "2 harness checks",
    );
    expect(
      within(checks).getAllByRole("row", { hidden: true }).slice(1),
    ).toHaveLength(2);
    await expectNoAxe(container);
  });

  it("says only harness checks were recorded when nothing else decided", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [sourcedEntry("2", "harness", "allow")],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.textContent).toContain(
      "Neither Oxagen policy nor an operator made a decision on this run.",
    );
    expect(screen.getByTestId("harness-checks")).toBeInTheDocument();
  });

  it("keeps a decision with no recorded source in the lead list", () => {
    render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [sourcedEntry("2", null, "allow")],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(screen.getAllByRole("row").slice(1)[0]?.textContent).toContain(
      "Not recorded",
    );
    expect(screen.queryByTestId("harness-checks")).toBeNull();
  });
});

describe("ContextSection", () => {
  it("links the run's own recall, names a subagent's without a link, and marks a cut list", async () => {
    const { container } = render(
      <IntlProvider>
        <ContextSection
          read={readOk(
            runTranscript({
              entries: [recallEntry("7"), recallEntry("2", CHAIN)],
              cursor: null,
              complete: false,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const [own, subagent] = rows;
    if (own === undefined || subagent === undefined)
      throw new Error("expected two rows");
    expect(within(own).queryByRole("link")).not.toBeNull();
    expect(within(subagent).queryByRole("link")).toBeNull();
    expect(container.querySelector("p.pt-3")).not.toBeNull();
    await expectNoAxe(container);
  });

  it("says there is nothing to list, and shows a failed read instead of a list", () => {
    const empty = render(
      <IntlProvider>
        <ContextSection
          read={readOk(runTranscript({ entries: [], cursor: null }))}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(empty.container.querySelector("table")).toBeNull();
    cleanup();
    const failed = render(
      <IntlProvider>
        <ContextSection
          read={readError("frame_store_unreachable", 502)}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(failed.container.querySelector("table")).toBeNull();
  });
});

describe("PolicySection with no decisions", () => {
  it("says there is nothing to list", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(runTranscript({ entries: [], cursor: null }))}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent.length).toBeGreaterThan(0);
  });
});

// #4024: the Issues tab lists the run's task reference and the issues its own
// pull requests close, by GitHub's record. A pull request matched by branch
// name is a guess and adds nothing; an unread list never reads as empty.
describe("IssuesList", () => {
  const repository = {
    host: "github.com",
    owner: "acme",
    name: "app",
    url: "https://github.com/acme/app",
    connected: true,
  };
  const issue = (number: number) => ({
    owner: "acme",
    repo: "app",
    number,
    title: `Issue ${String(number)}`,
    url: `https://github.com/acme/app/issues/${String(number)}`,
    state: "open" as const,
  });
  const pr = (
    number: number,
    association: "recorded" | "head_commit" | "branch",
    closingIssues: RunWork["pullRequests"][number]["closingIssues"],
  ): RunWork["pullRequests"][number] => ({
    repository,
    number,
    url: `https://github.com/acme/app/pull/${String(number)}`,
    title: "Repair",
    state: "open",
    headSha: "abc",
    headRef: "fix/work",
    association,
    closingIssues,
    checkoutRefs: [],
    observedAt: AT,
    current: true,
    ci: null,
    diff: null,
  });
  const work = (pullRequests: RunWork["pullRequests"]): RunWork => ({
    runId: "tse_7k2m9q",
    machine: null,
    checkouts: [],
    diffs: [],
    pullRequests,
    complete: true,
    warnings: [],
  });

  it("lists the issues a recorded pull request closes and ignores a branch match", async () => {
    const { container } = render(
      <IntlProvider>
        <IssuesList
          taskRef="OXA-1"
          read={readOk(
            work([
              pr(42, "recorded", { issues: [issue(7)], complete: true }),
              pr(43, "branch", { issues: [issue(9)], complete: true }),
            ]),
          )}
        />
      </IntlProvider>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "OXA-1Task the run was started on",
      "acme/app#7Pull request #42 closes it",
    ]);
    expect(
      screen.getByRole("link", { name: "acme/app#7" }).getAttribute("href"),
    ).toBe("https://github.com/acme/app/issues/7");
    expect(screen.queryByText(/acme\/app#9/)).toBeNull();
    await expectNoAxe(container);
  });

  it("says GitHub's list was not read instead of saying no pull request closes an issue", () => {
    render(
      <IntlProvider>
        <IssuesList
          taskRef={null}
          read={readOk(work([pr(42, "recorded", null)]))}
        />
      </IntlProvider>,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByText(/GitHub did not return the issues/),
    ).not.toBeNull();
    expect(screen.queryByText(/no pull request it opened/)).toBeNull();
  });

  it("names no issue when the task reference is empty and every list was read", () => {
    render(
      <IntlProvider>
        <IssuesList
          taskRef={null}
          read={readOk(
            work([pr(42, "recorded", { issues: [], complete: true })]),
          )}
        />
      </IntlProvider>,
    );
    expect(
      screen.getByText(
        "This run names no issue, and no pull request it opened closes one.",
      ),
    ).not.toBeNull();
  });

  it("keeps the task reference while the pull requests are read, and after the read fails", () => {
    const { rerender } = render(
      <IntlProvider>
        <IssuesList taskRef="OXA-1" read={null} />
      </IntlProvider>,
    );
    expect(screen.getByText("OXA-1")).not.toBeNull();
    expect(screen.getByText("Reading the run's pull requests.")).not.toBeNull();
    rerender(
      <IntlProvider>
        <IssuesList taskRef="OXA-1" read={readError("unavailable", 503)} />
      </IntlProvider>,
    );
    expect(screen.getByText("OXA-1")).not.toBeNull();
    expect(screen.queryByText("Reading the run's pull requests.")).toBeNull();
  });
});
