// @vitest-environment jsdom
// The steering PR panel in every state of its machine: where the state sits,
// which checks ran and how they came out, what merge will do, the merge that
// stays disabled until every check passed, the merged record, a closed
// proposal, and a failed read. It also covers the review each governance mode
// asks for, a drifted managed block, and a memory PR whose records no read
// returns yet. A steering PR proposal (#5122) merges from any open status and
// offers no control that runs the record checks, while a governance change
// keeps its gate. Every state gets an axe check.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalStatus } from "@/data/contracts/steering";
import { type Read, readError } from "@/data/read";
import type { SteeringPr } from "@/data/contracts/steering";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { readOk } from "@/data/read";
import {
  AT,
  steeringPr,
  memoryPrRecords,
  steeringPrSteeringPr,
} from "@/test/steering-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  openSteeringPr: vi.fn(),
  mergeSteeringPr: vi.fn(),
  dismissProposal: vi.fn(),
  approveSteeringPr: vi.fn(),
  mergePrWithoutReview: vi.fn(),
  restoreManagedBlock: vi.fn(),
  revertSteeringPr: vi.fn(),
  dropMemoryRecord: vi.fn(),
}));

const { SteeringPrPanel } = await import("./steering-pr-panel");

type PanelProps = Omit<Parameters<typeof SteeringPrPanel>[0], "at" | "read">;

function renderPanel(read: Read<SteeringPr>, props: PanelProps = {}) {
  render(
    <IntlProvider>
      <SteeringPrPanel at={AT} read={read} {...props} />
    </IntlProvider>,
  );
  return screen.getByRole("region");
}

const renderState = (status: ProposalStatus) =>
  renderPanel(readOk(steeringPr(status)));

const merge = () =>
  screen.queryByRole("button", { name: "Merge pull request" });
const approve = () => screen.queryByRole("button", { name: "Approve" });
const mergeWithoutReview = () =>
  screen.queryByRole("button", { name: "Merge without review" });
const revert = () =>
  screen.queryByRole("button", { name: "Revert pull request" });

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
    const machine = screen.getByRole("list", { name: "Steering PR state" });
    const current = within(machine)
      .getAllByRole("listitem")
      .filter((step) => step.getAttribute("aria-current") === "step");
    expect(current.map((step) => step.textContent)).toEqual([label]);
  });

  it("marks no step for a closed proposal and says what closing did", () => {
    const panel = renderState("rejected");
    const machine = screen.getByRole("list", { name: "Steering PR state" });
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
      screen.getByRole("button", { name: "Open a steering PR" }),
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
      "Merge rule: team: an org Owner or Admin, or a workspace Owner or Admin, other than the author merges",
    ]);
    // The re-run stays offered after the checks pass: when the head moves,
    // merge_steering_pr refuses with `head_moved` and running the checks again
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

  it("offers Revert pull request on a merged steering PR (#4449)", () => {
    const panel = renderState("merged");
    expect(revert()).toBeEnabled();
    expect(panel.querySelector("[data-merged]")).toContainElement(revert());
  });

  it("offers no revert before the merge, on a dismissed proposal, or on a governance change (negative)", () => {
    for (const read of [
      steeringPr("checks_passed"),
      steeringPr("rejected"),
      // revert_steering_pr refuses a governance change (ADR-232).
      steeringPr("merged", { kind: "governance" }),
    ]) {
      renderPanel(readOk(read));
      expect(revert()).toBeNull();
      cleanup();
    }
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
      readOk(steeringPr("checks_passed", { governanceMode: "regulated" })),
    );
    expect(approve()).toBeEnabled();
    expect(merge()).toBeEnabled();
  });

  it("offers Merge alone under the solo mode, even to an owner (negative)", () => {
    const solo = steeringPr("checks_passed", { governanceMode: "solo" });
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
    const panel = renderPanel(readOk(steeringPr("checks_passed")), {
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
    const panel = renderPanel(readOk(steeringPr("checks_passed")), {
      canMergeWithoutReview: true,
    });
    expect(mergeWithoutReview()).toBeEnabled();
    expect(panel.querySelector('[data-fact="approvals"]')).toBeNull();
  });

  it("keeps Merge without review disabled until the checks pass (negative)", () => {
    renderPanel(readOk(steeringPr("checks_running")), {
      approvals: 0,
      canMergeWithoutReview: true,
    });
    expect(mergeWithoutReview()).toBeDisabled();
  });

  it("hides Merge without review once someone has approved (negative)", () => {
    const panel = renderPanel(readOk(steeringPr("checks_passed")), {
      approvals: 1,
      canMergeWithoutReview: true,
    });
    expect(mergeWithoutReview()).toBeNull();
    expect(panel.querySelector('[data-fact="approvals"] dd')).toHaveTextContent(
      "1",
    );
  });

  it("hides Merge without review from a member who is not an owner (negative)", () => {
    renderPanel(readOk(steeringPr("checks_passed")), { approvals: 0 });
    expect(mergeWithoutReview()).toBeNull();
    expect(approve()).toBeEnabled();
  });

  it("offers a governance change only Approve, Merge, and Close, which its server paths accept (#4795)", () => {
    renderPanel(readOk(steeringPr("checks_passed", { kind: "governance" })), {
      approvals: 0,
      canMergeWithoutReview: true,
    });
    // merge_pr_without_review and open_steering_pr refuse a governance change.
    expect(mergeWithoutReview()).toBeNull();
    expect(screen.queryByTestId("open-steering-pr-open")).toBeNull();
    expect(approve()).toBeEnabled();
    expect(merge()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close without merging" })).toBeEnabled();
  });

  it("lists what merging a governance change does, and no record or promotion event (#4795)", () => {
    const panel = renderPanel(
      readOk(
        steeringPr("checks_passed", {
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

  it("keeps Merge blocked on a governance change until its checks pass (negative)", () => {
    for (const status of ["pr_open", "checks_failed"] as const) {
      const panel = renderPanel(readOk(steeringPr(status, { kind: "governance" })));
      expect(merge()).toBeDisabled();
      expect(panel).toHaveTextContent(
        "Merge is blocked until every check passes.",
      );
      expect(screen.queryByTestId("open-steering-pr-open")).toBeNull();
      cleanup();
    }
  });
});

describe("a steering PR proposal (#5122)", () => {
  const onMergeSteps = (panel: HTMLElement) =>
    [...(panel.querySelector("[data-on-merge]")?.querySelectorAll("li") ?? [])].map(
      (li) => li.textContent,
    );

  it("enables Merge on a tools PR at pull request open and offers no control that runs the record checks", () => {
    const panel = renderPanel(readOk(steeringPrSteeringPr("tools", "pr_open")));
    expect(merge()).toBeEnabled();
    expect(panel).not.toHaveTextContent("Merge is blocked");
    // open_steering_pr refuses a steering PR: its merge runs the steering checks.
    expect(screen.queryByTestId("open-steering-pr-open")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Run the checks again" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Close without merging" }),
    ).toBeEnabled();
    expect(panel.querySelector("[data-check]")).toBeNull();
    expect(panel.querySelector('[data-fact="path"] dt')).toHaveTextContent(
      "Folder",
    );
    expect(panel.querySelector('[data-fact="path"] dd')).toHaveTextContent(
      "tools/github",
    );
  });

  it.each(["pr_open", "checks_running", "checks_passed", "checks_failed"] as const)(
    "enables Merge and Merge without review at %s, the statuses merge_steering_pr takes",
    (status) => {
      renderPanel(readOk(steeringPrSteeringPr("import", status)), {
        approvals: 0,
        canMergeWithoutReview: true,
      });
      expect(merge()).toBeEnabled();
      expect(mergeWithoutReview()).toBeEnabled();
    },
  );

  it("blocks Merge while no pull request is open (negative)", () => {
    renderPanel(readOk(steeringPrSteeringPr("tools", "proposed")));
    expect(merge()).toBeDisabled();
  });

  it("lists what merging the files does, with no record and no promotion event", () => {
    const panel = renderPanel(
      readOk(steeringPrSteeringPr("tools", "checks_failed")),
    );
    expect(onMergeSteps(panel)).toEqual([
      "Run the steering checks on the pull request's latest commit",
      "Merge the pull request's files into the production branch",
      "Publish the next steering version",
      "Merge rule: team: an org Owner or Admin, or a workspace Owner or Admin, other than the author merges",
    ]);
    expect(panel.querySelector("[data-on-merge]")).not.toHaveTextContent(
      "promotion",
    );
  });

  it("names the records a revert retires among what merge will do", () => {
    const panel = renderPanel(readOk(steeringPrSteeringPr("revert", "pr_open")));
    expect(onMergeSteps(panel)).toEqual([
      "Run the steering checks on the pull request's latest commit",
      "Merge the pull request's files into the production branch",
      "Retire each record whose file the revert deletes",
      "Publish the next steering version",
      "Merge rule: team: an org Owner or Admin, or a workspace Owner or Admin, other than the author merges",
    ]);
  });

  it("retires nothing on a PR that is no revert (negative)", () => {
    const panel = renderPanel(
      readOk(steeringPrSteeringPr("agent_proposal", "pr_open")),
    );
    expect(panel.querySelector("[data-on-merge]")).not.toHaveTextContent(
      "Retire",
    );
  });

  it("names the repository root for files at the top of the repository", () => {
    const panel = renderPanel(
      readOk(
        steeringPrSteeringPr("agent_file", "pr_open", {
          onMerge: { path: ".", bundleVersion: { current: 41, afterMerge: 41 } },
        }),
      ),
    );
    expect(panel.querySelector('[data-fact="path"] dd')).toHaveTextContent(
      "repository root",
    );
  });

  it("offers Revert pull request on a merged memory PR and prints no promotion event or record", () => {
    const panel = renderPanel(readOk(steeringPrSteeringPr("memory_pr", "merged")));
    const merged = panel.querySelector("[data-merged]");
    expect(revert()).toBeEnabled();
    expect(merged).toContainElement(revert());
    expect(merged?.querySelector('[data-fact="commit"] dd')).toHaveTextContent(
      "4d5e6f7a8b9c",
    );
    expect(merged?.querySelector('[data-fact="promotion-event"]')).toBeNull();
    expect(merged?.querySelector('[data-fact="record"]')).toBeNull();
    expect(merge()).toBeNull();
  });
});

describe("a drifted managed block", () => {
  it("names each drifted file once with a Restore block button", () => {
    renderPanel(readOk(steeringPr("checks_failed")), {
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
    renderPanel(readOk(steeringPr("merged")), {
      findings: [{ rule: "managed-block", path: "AGENTS.md", message: "" }],
    });
    expect(document.querySelector("[data-drift]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore block" })).toBeNull();
  });
});

describe("a memory PR", () => {
  const BRANCH = "memory/2026-09-27-release-lessons";
  const memoryPr = (records?: PanelProps["memoryRecords"]) => {
    const base = steeringPr("checks_passed");
    if (base.pr === null) throw new Error("fixture has a pull request");
    return renderPanel(
      readOk({ ...base, pr: { ...base.pr, branch: BRANCH } }),
      records === undefined ? {} : { memoryRecords: records },
    );
  };
  const onBranch = (overrides: Parameters<typeof memoryPrRecords>[0] = {}) => {
    const read = memoryPrRecords(overrides);
    return readOk({
      ...read,
      pullRequest: { ...read.pullRequest, branch: BRANCH },
    });
  };

  it("lists each record list_memory_pr_records answers, with a Drop button", () => {
    memoryPr(onBranch());
    expect(
      screen.getByRole("heading", { name: "Memory records" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 4, name: "Draft releases only" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Drop Draft releases only" }),
    ).toBeEnabled();
    expect(screen.queryByTestId("memory-pr-records-not-backed")).toBeNull();
  });

  it("says the memory PR proposes no record when it holds none", () => {
    memoryPr(onBranch({ records: [] }));
    expect(
      document.querySelector("[data-memory-pr]"),
    ).toHaveTextContent("This memory PR proposes no record.");
  });

  it("names the read's failure in place of the records (negative)", () => {
    memoryPr(readError("memory_store_unavailable", 503));
    expect(
      document.querySelector("[data-memory-pr]"),
    ).toHaveTextContent(
      "Memory records could not be loaded: memory_store_unavailable.",
    );
    expect(screen.queryByRole("button", { name: /^Drop / })).toBeNull();
  });

  it("draws no records of a memory PR with the same number on another branch (negative)", () => {
    memoryPr(readOk(memoryPrRecords()));
    expect(
      document.querySelector("[data-memory-pr]"),
    ).toHaveTextContent("Memory records could not be loaded: not_found.");
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
  });

  it("draws no memory section when no read of the records arrives (negative)", () => {
    memoryPr();
    expect(document.querySelector("[data-memory-pr]")).toBeNull();
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
      "You cannot see Steering PR in this workspace.",
    ],
    [readError("not_found", 404), "Steering PR could not be loaded: not_found."],
  ])("renders the failure in place of the panel", (read, text) => {
    const panel = renderPanel(read);
    expect(panel).toHaveTextContent(text);
    expect(merge()).toBeNull();
  });
});
