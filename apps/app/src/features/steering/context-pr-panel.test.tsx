// @vitest-environment jsdom
// The Context PR panel in every state of its machine: where the state sits,
// which checks ran and how they came out, what merge will do, the merge that
// stays disabled until every check passed, the merged record, a dismissed
// proposal, and a failed read, with an axe check in every one.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalStatus } from "@/data/contracts/steering";
import { type Read, readError } from "@/data/read";
import type { ContextPr } from "@/data/contracts/steering";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { readOk } from "@/data/read";
import { AT, contextPr, PR_URL } from "@/test/steering-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  openContextPr: vi.fn(),
  mergeContextPr: vi.fn(),
  dismissProposal: vi.fn(),
}));

const { ContextPrPanel } = await import("./context-pr-panel");

function renderPanel(read: Read<ContextPr>) {
  render(
    <IntlProvider>
      <ContextPrPanel at={AT} read={read} />
    </IntlProvider>,
  );
  return screen.getByRole("region");
}

const renderState = (status: ProposalStatus) =>
  renderPanel(readOk(contextPr(status)));

const merge = () =>
  screen.queryByRole("button", { name: "Merge pull request" });

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

  it("marks no step for a dismissed proposal and says what dismissal did", () => {
    const panel = renderState("rejected");
    const machine = screen.getByRole("list", { name: "Context PR state" });
    expect(machine.querySelector('[aria-current="step"]')).toBeNull();
    expect(panel).toHaveTextContent(
      "This proposal was dismissed. Its pull request is closed and its branch deleted.",
    );
    expect(merge()).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
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
      "read from .oxagen/rules/governance.toml when the pull request opens",
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
  it("enables merge, links the pull request and says what merge will do", () => {
    const panel = renderState("checks_passed");
    expect(merge()).toBeEnabled();
    expect(panel).not.toHaveTextContent("Merge is blocked");
    const link = screen.getByRole("link", { name: "Go to pull request #519" });
    expect(link).toHaveAttribute("href", PR_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(panel.querySelector('[data-fact="branch"] dd')).toHaveTextContent(
      "context/ctx.release.no-reread-changelog into main",
    );
    expect(panel.querySelector('[data-fact="head"] dd')).toHaveTextContent(
      "9f8e7d6c5b4a",
    );
    const onMerge = panel.querySelector("[data-on-merge]");
    expect(
      [...(onMerge?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
    ).toEqual([
      "Publish .oxagen/rules/ctx.release.no-reread-changelog.toml as a record in force",
      "Move this workspace from steering version 41 to 42",
      "Write the promotion event to the ledger and a steering_published audit event",
      "Who merges, under governance mode team: an org Owner or Admin, or a workspace Owner, other than the author merges",
    ]);
    // The re-run stays offered after the checks pass: when the head moves,
    // merge_context_pr refuses with `head_moved` and running the checks again
    // is the only control that clears it.
    expect(
      screen.getByRole("button", { name: "Run the checks again" }),
    ).toBeEnabled();
  });

  it("does not link a pull request URL that is not a GitHub pull request page (negative)", () => {
    const base = contextPr("checks_passed");
    if (base.pr === null) throw new Error("fixture has a pull request");
    renderPanel(
      readOk({
        ...base,
        pr: { ...base.pr, url: "https://github.com.evil/acme/core/pull/519" },
      }),
    );
    expect(screen.queryByRole("link")).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
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
