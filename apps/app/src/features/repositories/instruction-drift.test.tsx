// @vitest-environment jsdom
// The instruction-file findings a code repository shows, over fake
// promotions (#4518, ADR-254). Each finding names the file and line, quotes
// the statement, names the steering record, and links its pull request. A
// contradiction offers Promote to steering, which sends the finding's id to
// `promote_instruction_to_steering`. The refusals are the ones its handler
// gives.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { InstructionDriftFinding } from "./instruction-drift";

const actions = vi.hoisted(() => ({
  promoteInstructionToSteering: vi.fn(),
}));
vi.mock("./actions", () => actions);

const { InstructionDriftWarning } = await import("./instruction-drift");

const CONTRADICTION: InstructionDriftFinding = {
  id: "crf_contra1",
  path: "AGENTS.md",
  line: 12,
  statement: "Always push to main.",
  kind: "contradiction",
  record: "Never push to main",
  pullRequest: {
    number: 318,
    url: "https://github.com/acme/api/pull/318",
    merged: false,
  },
  proposalId: null,
};

const REPEAT: InstructionDriftFinding = {
  ...CONTRADICTION,
  id: "crf_repeat1",
  path: ".cursor/rules/review.mdc",
  line: 4,
  statement: "Run every tenant query inside withTenantDb.",
  kind: "repeat",
  record: "Scope every tenant query",
  pullRequest: { ...CONTRADICTION.pullRequest, merged: true },
};

function warning(findings: readonly InstructionDriftFinding[]) {
  return render(
    <IntlProvider>
      <InstructionDriftWarning org="acme" ws="core-platform" findings={findings} />
    </IntlProvider>,
  );
}

beforeEach(() => {
  actions.promoteInstructionToSteering.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the instruction file findings", () => {
  it("draws nothing when no statement differs (negative)", () => {
    const { container } = warning([]);
    expect(screen.queryByTestId("instruction-drift")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("names each file and line, quotes the statement, and names the record and pull request", () => {
    warning([CONTRADICTION, REPEAT]);
    const findings = screen.getAllByTestId("instruction-drift-finding");
    expect(findings.map((finding) => finding.dataset.path)).toEqual([
      "AGENTS.md",
      ".cursor/rules/review.mdc",
    ]);
    const [contradiction, repeat] = findings;
    expect(contradiction).toHaveTextContent("AGENTS.md line 12");
    expect(contradiction).toHaveTextContent("Always push to main.");
    expect(contradiction).toHaveTextContent(
      "It says the opposite of the steering record Never push to main.",
    );
    expect(
      screen.getByRole("link", { name: "Pull request #318" }),
    ).toHaveAttribute("href", "https://github.com/acme/api/pull/318");
    expect(repeat).toHaveTextContent(
      "It says what the steering record Scope every tenant query already says.",
    );
    expect(repeat).toHaveTextContent("Merged in pull request #318");
  });

  it("offers Promote to steering on a contradiction only", () => {
    warning([CONTRADICTION, REPEAT]);
    const buttons = screen.getAllByTestId("instruction-drift-promote");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Promote to steering");
    expect(buttons[0]?.closest("li")?.dataset.kind).toBe("contradiction");
  });

  it("names the proposal already in flight instead of offering a second promote", () => {
    warning([{ ...CONTRADICTION, proposalId: "prp_earlier1" }]);
    expect(screen.queryByTestId("instruction-drift-promote")).toBeNull();
    expect(screen.getByTestId("instruction-drift-proposed")).toHaveTextContent(
      "Proposed as steering proposal prp_earlier1.",
    );
  });

  it("promotes the finding a person picked and names the steering proposal", async () => {
    actions.promoteInstructionToSteering.mockResolvedValue({
      ok: true,
      value: {
        proposalId: "prp_7a8b9c",
        pullRequestUrl: "https://github.com/acme/oxagen-core/pull/7",
      },
    });
    warning([CONTRADICTION]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-promoted"),
    ).toHaveTextContent(
      "Oxagen opened steering proposal prp_7a8b9c. The line steers runs once its steering PR merges.",
    );
    expect(actions.promoteInstructionToSteering).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "crf_contra1",
    );
    expect(screen.queryByTestId("instruction-drift-promote")).toBeNull();
    expect(screen.queryByTestId("instruction-drift-failure")).toBeNull();
  });

  it("shows the pending label and promotes once however many times a person clicks", async () => {
    let answer: (value: unknown) => void = () => {};
    actions.promoteInstructionToSteering.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    warning([CONTRADICTION]);
    const promote = screen.getByTestId("instruction-drift-promote");
    await userEvent.click(promote);
    expect(promote).toHaveTextContent("Promoting");
    expect(promote).toBeDisabled();
    await userEvent.click(promote);
    expect(actions.promoteInstructionToSteering).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: { proposalId: "prp_7a8b9c", pullRequestUrl: null } });
    expect(
      await screen.findByTestId("instruction-drift-promoted"),
    ).toBeInTheDocument();
  });

  it("names the refusal when another steering PR is open on the record, and keeps the button (negative)", async () => {
    actions.promoteInstructionToSteering.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "lineage_pr_open",
    });
    warning([CONTRADICTION]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-failure"),
    ).toHaveTextContent(
      "A steering PR for this record is already open. Merge or dismiss it, then promote the line.",
    );
    expect(screen.queryByTestId("instruction-drift-promoted")).toBeNull();
    expect(screen.getByTestId("instruction-drift-promote")).toBeEnabled();
  });

  it("names the refusal when the line no longer differs from a record (negative)", async () => {
    actions.promoteInstructionToSteering.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "finding_resolved",
    });
    warning([CONTRADICTION]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-failure"),
    ).toHaveTextContent(
      "This line no longer differs from a steering record, so there is nothing to promote.",
    );
  });

  it("says the promotion went unanswered when the call threw (negative)", async () => {
    actions.promoteInstructionToSteering.mockRejectedValue(
      new Error("network down"),
    );
    warning([CONTRADICTION]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    await waitFor(() =>
      expect(screen.getByTestId("instruction-drift-failure")).toHaveTextContent(
        "action_failed",
      ),
    );
    expect(screen.queryByTestId("instruction-drift-promoted")).toBeNull();
  });

  it("clears the last failure when a person tries again and it lands", async () => {
    actions.promoteInstructionToSteering
      .mockResolvedValueOnce({
        ok: false,
        reason: "unavailable",
        code: "github_down",
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { proposalId: "prp_1d2e3f", pullRequestUrl: null },
      });
    warning([CONTRADICTION]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-failure"),
    ).toHaveTextContent("github_down");
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-promoted"),
    ).toHaveTextContent("prp_1d2e3f");
    expect(screen.queryByTestId("instruction-drift-failure")).toBeNull();
  });
});
