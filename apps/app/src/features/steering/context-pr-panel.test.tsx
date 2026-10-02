// @vitest-environment jsdom
// The steering PR panel in every state of its machine: where the state sits,
// which checks ran and how they came out, what merge will do, the merge that
// stays disabled until every check passed, the merged record, a closed
// proposal, and a failed read. It also covers the review each governance mode
// asks for, a drifted managed block, and a memory PR whose records no read
// returns yet. Every state gets an axe check.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalStatus } from "@/data/contracts/steering";
import { type Read, readError } from "@/data/read";
import type { ContextPr } from "@/data/contracts/steering";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { readOk } from "@/data/read";
import { AT, contextPr } from "@/test/steering-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  openContextPr: vi.fn(),
  mergeContextPr: vi.fn(),
  dismissProposal: vi.fn(),
  approveContextPr: vi.fn(),
  mergePrWithoutReview: vi.fn(),
  restoreManagedBlock: vi.fn(),
  dropMemoryRecord: vi.fn(),
}));

const { ContextPrPanel } = await import("./context-pr-panel");

type PanelProps = Omit<Parameters<typeof ContextPrPanel>[0], "at" | "read">;

function renderPanel(read: Read<ContextPr>, props: PanelProps = {}) {
  render(
    <IntlProvider>
      <ContextPrPanel at={AT} read={read} {...props} />
    </IntlProvider>,
  );
  return screen.getByRole("region");
}

const renderState = (status: ProposalStatus) =>
  renderPanel(readOk(contextPr(status)));

const merge = () =>
  screen.queryByRole("button", { name: "Merge pull request" });
const approve = () => screen.queryByRole("button", { name: "Approve" });
const mergeWithoutReview = () =>
  screen.queryByRole("button", { name: "Merge without review" });

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the state machine", () => {
  it.each<[ProposalStatus, string]>([
    ["proposed", "proposed"],
    ["pr_open", "pull request open"],
    ["checks_running", "checks running"],
    ["checks_passed", "checks passed"],
    ["checks_failed", "checks failed"],
    ["merged", "merged"],
  ])("marks %s as the current step", (status, label) => {
    renderState(status);
    const machine = screen.getByRole("list", { name: "Context PR state" });
    const current = within(machine)
      .getAllByRole("listitem")
      .filter((step) => step.getAttribute("aria-current") === "step");
    expect(current.map((step) => step.textContent)).toEqual([label]);
  });

  it("marks no step for a closed proposal and says what closing did", () => {
    const panel = renderState("rejected");
    const machine = screen.getByRole("list", { name: "Context PR state" });
    expect(machine.querySelector('[aria-current="step"]')).toBeNull();
    expect(panel).toHaveTextContent(
      "This proposal is closed. Its pull request is closed and its branch deleted.",
    );
    expect(merge()).toBeNull();
    expect(screen.queryByRole("button", { name: "Close without merging" })).toBeNull();
  });
});

describe("before the pull request opens", () => {
  it("says none is open, links nothing, prints the file and when the mode is read, and blocks merge", () => {
    const panel = renderState("proposed");
    expect(panel).toHaveTextContent(
      "No pull request is open for this proposal yet.",
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(panel.querySelector('[data-fact="path"] dd')).toHaveTextContent(
      ".oxagen/rules/ctx.release.no-reread-changelog.toml",
    );
    expect(
      panel.querySelector('[data-fact="governance"] dd'),
    ).toHaveTextContent(
      // The panel names no layout's file: a steering repository keeps it at
      // steering/governance.toml, a legacy one under .oxagen/rules/ (#4821).
      "read from the governance file when the pull request opens",
    );
    expect(panel.querySelector("[data-check]")).toBeNull();
    expect(merge()).toBeDisabled();
    expect(panel).toHaveTextContent(
      "Merge is blocked until every check passes.",
    );
    expect(
      screen.getByRole("button", { name: "Open a Context PR" }),
    ).toBeInTheDocument();
  });
});

describe("the checks", () => {
  it("prints each check in the order it runs, one running at a time, and keeps merge disabled (negative)", () => {
    const panel = renderState("checks_running");
    expect(
      [...panel.querySelectorAll("[data-check]")].map((check) => [
        check.getAttribute("data-check"),
        check.getAttribute("data-status"),
      ]),
    ).toEqual([
      ["schema", "passed"],
      ["lineage_uniqueness", "passed"],
      ["record_hash", "running"],
      ["secret_pii_scan", "pending"],
      ["conflict_against_active", "pending"],
      ["constraint_effect", "pending"],
    ]);
    expect(panel.querySelector('[data-check="record_hash"]')).toHaveTextContent(
      "record_hash recomputationrunning",
    );
    expect(merge()).toBeDisabled();
  });

  it("names a failing check with what it found, blocks merge and offers to run the checks again (negative)", () => {
    const panel = renderState("checks_failed");
    expect(
      panel.querySelector('[data-check="secret_pii_scan"]'),
    ).toHaveTextContent(
      "Secret and PII scana string shaped like an access key on line 12fail",
    );
    expect(merge()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Run the checks again" }),
    ).toBeInTheDocument();
  });
});

describe("once every check passed", () => {
  it("enables merge and says what merge will do", () => {
    const panel = renderState("checks_passed");
    expect(merge()).toBeEnabled();
    expect(panel).not.toHaveTextContent("Merge is blocked");
    // The page header carries the link to the pull request (#5077).
    expect(screen.queryByRole("link")).toBeNull();
    expect(panel.querySelector('[data-fact="branch"] dd')).toHaveTextContent(
      "steering/ctx.release.no-reread-changelog into main",
    );
    expect(panel.querySelector('[data-fact="head"] dd')).toHaveTextContent(
      "9f8e7d6c5b4a",
    );
    const onMerge = panel.querySelector("[data-on-merge]");
    expect(
      [...(onMerge?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
    ).toEqual([
      "Publish .oxagen/rules/ctx.release.no-reread-changelog.toml as a record in force",
      "Take the workspace's promotion ledger from 41 entries to 42",
      "Write the promotion event to the ledger and a steering_published audit event",
      "Merge rule: team: an org Owner or Admin, or a workspace Owner, other than the author merges",
    ]);
    // The re-run stays offered after the checks pass: when the head moves,
    // merge_context_pr refuses with `head_moved` and running the checks again
    // is the only control that clears it.
    expect(
      screen.getByRole("button", { name: "Run the checks again" }),
    ).toBeEnabled();
  });

  it("prints a pull request with no checked commit yet as not committed", () => {
    const panel = renderState("pr_open");
    expect(panel.querySelector('[data-fact="head"] dd')).toHaveTextContent(
      "not committed yet",
    );
  });
});

describe("after merge", () => {
  it("prints the merge commit, the promotion event and the published record, with no merge and nothing still to do", () => {
    const panel = renderState("merged");
    const merged = panel.querySelector("[data-merged]");
    expect(merged?.querySelector('[data-fact="commit"] dd')).toHaveTextContent(
      "4d5e6f7a8b9c",
    );
    expect(
      merged?.querySelector('[data-fact="promotion-event"] dd'),
    ).toHaveTextContent("ctp_8qm2x4");
    expect(merged?.querySelector('[data-fact="record"] dd')).toHaveTextContent(
      "ctr_7k2m9q4x",
    );
    expect(panel.querySelector("[data-on-merge]")).toBeNull();
    expect(merge()).toBeNull();
    expect(screen.queryByRole("button", { name: "Close without merging" })).toBeNull();
  });
});

describe("the review each governance mode asks for", () => {
  it("offers Approve beside Merge under the team mode", () => {
    renderState("checks_passed");
    expect(approve()).toBeEnabled();
    expect(merge()).toBeEnabled();
    expect(mergeWithoutReview()).toBeNull();
  });

  it("offers Approve under the regulated mode as well", () => {
    renderPanel(
      readOk(contextPr("checks_passed", { governanceMode: "regulated" })),
    );
    expect(approve()).toBeEnabled();
    expect(merge()).toBeEnabled();
  });

  it("offers Merge alone under the solo mode, even to an owner (negative)", () => {
    const solo = contextPr("checks_passed", { governanceMode: "solo" });
    renderPanel(readOk(solo), { approvals: 0, canMergeWithoutReview: true });
    expect(merge()).toBeEnabled();
    expect(approve()).toBeNull();
    expect(mergeWithoutReview()).toBeNull();
  });

  it("offers no Approve before the pull request opens (negative)", () => {
    renderState("proposed");
    expect(approve()).toBeNull();
  });

  it("offers an owner Merge without review while no one has approved", () => {
    const panel = renderPanel(readOk(contextPr("checks_passed")), {
      approvals: 0,
      canMergeWithoutReview: true,
    });
    expect(mergeWithoutReview()).toBeEnabled();
    expect(approve()).toBeEnabled();
    expect(merge()).toBeEnabled();
    expect(panel.querySelector('[data-fact="approvals"] dd')).toHaveTextContent(
      "0",
    );
  });

  it("treats an approval count the read does not carry as none", () => {
    const panel = renderPanel(readOk(contextPr("checks_passed")), {
      canMergeWithoutReview: true,
    });
    expect(mergeWithoutReview()).toBeEnabled();
    expect(panel.querySelector('[data-fact="approvals"]')).toBeNull();
  });

  it("keeps Merge without review disabled until the checks pass (negative)", () => {
    renderPanel(readOk(contextPr("checks_running")), {
      approvals: 0,
      canMergeWithoutReview: true,
    });
    expect(mergeWithoutReview()).toBeDisabled();
  });

  it("hides Merge without review once someone has approved (negative)", () => {
    const panel = renderPanel(readOk(contextPr("checks_passed")), {
      approvals: 1,
      canMergeWithoutReview: true,
    });
    expect(mergeWithoutReview()).toBeNull();
    expect(panel.querySelector('[data-fact="approvals"] dd')).toHaveTextContent(
      "1",
    );
  });

  it("hides Merge without review from a member who is not an owner (negative)", () => {
    renderPanel(readOk(contextPr("checks_passed")), { approvals: 0 });
    expect(mergeWithoutReview()).toBeNull();
    expect(approve()).toBeEnabled();
  });

  it("offers a governance change only Approve, Merge, and Close, which its server paths accept (#4795)", () => {
    renderPanel(readOk(contextPr("checks_passed", { kind: "governance" })), {
      approvals: 0,
      canMergeWithoutReview: true,
    });
    // merge_pr_without_review and open_context_pr refuse a governance change.
    expect(mergeWithoutReview()).toBeNull();
    expect(screen.queryByTestId("open-context-pr")).toBeNull();
    expect(approve()).toBeEnabled();
    expect(merge()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close without merging" })).toBeEnabled();
  });

  it("lists what merging a governance change does, and no record or promotion event (#4795)", () => {
    const panel = renderPanel(
      readOk(
        contextPr("checks_passed", {
          kind: "governance",
          onMerge: { path: "steering/governance.toml", bundleVersion: { current: 0, afterMerge: 0 } },
        }),
      ),
    );
    const onMerge = panel.querySelector("[data-on-merge]");
    expect(onMerge).toHaveTextContent("Put the mode in steering/governance.toml in force");
    expect(onMerge).not.toHaveTextContent("as a record in force");
    expect(onMerge).not.toHaveTextContent("promotion event");
    expect(onMerge).not.toHaveTextContent("promotion ledger");
  });
});

describe("a drifted managed block", () => {
  it("names each drifted file once with a Restore block button", () => {
    renderPanel(readOk(contextPr("checks_failed")), {
      findings: [
        {
          rule: "managed-block",
          path: "AGENTS.md",
          message: "The managed block no longer matches the published version.",
        },
        { rule: "managed-block", path: "AGENTS.md", message: "" },
        { rule: "secret-scan", path: "CLAUDE.md", message: "an access key" },
      ],
    });
    const heading = screen.getByRole("heading", { name: "Drift in AGENTS.md" });
    const drift = heading.closest("[data-drift]");
    if (!(drift instanceof HTMLElement)) throw new Error("no drift block");
    expect(drift).toHaveAttribute("data-drift", "AGENTS.md");
    expect(drift).toHaveTextContent(
      "The managed block no longer matches the published version.",
    );
    expect(
      within(drift).getByRole("button", { name: "Restore block" }),
    ).toBeEnabled();
    expect(document.querySelectorAll("[data-drift]")).toHaveLength(1);
    expect(screen.queryByText(/Drift in CLAUDE\.md/)).toBeNull();
  });

  it("shows no drift once the steering PR merged (negative)", () => {
    renderPanel(readOk(contextPr("merged")), {
      findings: [{ rule: "managed-block", path: "AGENTS.md", message: "" }],
    });
    expect(document.querySelector("[data-drift]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore block" })).toBeNull();
  });
});

describe("a memory PR", () => {
  const memoryPr = (records?: PanelProps["memoryRecords"]) => {
    const base = contextPr("checks_passed");
    if (base.pr === null) throw new Error("fixture has a pull request");
    return renderPanel(
      readOk({
        ...base,
        pr: { ...base.pr, branch: "memory/2026-09-27-release-lessons" },
      }),
      records === undefined ? {} : { memoryRecords: records },
    );
  };

  it("says no read returns its records yet when none arrive", () => {
    memoryPr();
    expect(
      screen.getByRole("heading", { name: "Memory records" }),
    ).toBeInTheDocument();
    const notBacked = screen.getByTestId("memory-pr-records-not-backed");
    expect(notBacked).toHaveTextContent(
      "Not recorded yet: the records on this memory branch and the memories each one cites. It needs list_memory_pr_records.",
    );
  });

  it("lists each record with a Drop button when the records arrive", () => {
    memoryPr([
      {
        path: ".oxagen/memory/release.no-reread-changelog.toml",
        lineage: "mem.release.no-reread-changelog",
        title: "Do not re-read the changelog",
        summary: "Agents read CHANGELOG.md once per release run.",
        memories: [],
        dropped: null,
      },
    ]);
    expect(screen.queryByTestId("memory-pr-records-not-backed")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Drop Do not re-read the changelog" }),
    ).toBeEnabled();
  });

  it("shows no memory section on a steering PR from a steering branch (negative)", () => {
    renderState("checks_passed");
    expect(document.querySelector("[data-memory-pr]")).toBeNull();
  });
});

describe("a read that failed", () => {
  it.each([
    [
      { ok: false, reason: "denied", permission: "steering.read" } as const,
      "You cannot see Context PR in this workspace.",
    ],
    [readError("not_found", 404), "Context PR could not be loaded: not_found."],
  ])("renders the failure in place of the panel", (read, text) => {
    const panel = renderPanel(read);
    expect(panel).toHaveTextContent(text);
    expect(merge()).toBeNull();
  });
});
