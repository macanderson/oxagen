// @vitest-environment jsdom
// The drift warning a code repository shows over fake promotions (#4518). Each
// finding names the file that drifted from the steering records, and Promote
// to steering asks the platform to propose that file as a steering record.
// The platform does not register `promote_instruction_to_steering` yet, so the
// refusal a deployment answers today is covered as well as the proposal.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const actions = vi.hoisted(() => ({
  promoteInstructionToSteering: vi.fn(),
}));
vi.mock("./actions", () => actions);

const { InstructionDriftWarning } = await import("./instruction-drift");

const REPOSITORY_ID = "rpb_link01";

function warning(paths: readonly string[]) {
  return render(
    <IntlProvider>
      <InstructionDriftWarning
        org="acme"
        ws="core-platform"
        repositoryId={REPOSITORY_ID}
        findings={paths.map((path) => ({ path }))}
      />
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

describe("the instruction drift warning", () => {
  it("draws nothing when no file drifted (negative)", () => {
    const { container } = warning([]);
    expect(screen.queryByTestId("instruction-drift")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("names each file that drifted and offers to promote it", () => {
    warning(["AGENTS.md", ".cursor/rules/review.mdc"]);
    const findings = screen.getAllByTestId("instruction-drift-finding");
    expect(findings.map((finding) => finding.dataset.path)).toEqual([
      "AGENTS.md",
      ".cursor/rules/review.mdc",
    ]);
    expect(findings[0]).toHaveTextContent(
      "AGENTS.md differs from the steering records.",
    );
    const buttons = screen.getAllByTestId("instruction-drift-promote");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent("Promote to steering");
  });

  it("promotes the file a person picked and names the steering proposal", async () => {
    actions.promoteInstructionToSteering.mockResolvedValue({
      ok: true,
      value: { proposalId: "stp_7a8b9c" },
    });
    warning(["AGENTS.md"]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-promoted"),
    ).toHaveTextContent(
      "Oxagen opened steering proposal stp_7a8b9c. The file steers runs once its steering PR merges.",
    );
    expect(actions.promoteInstructionToSteering).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { repositoryId: REPOSITORY_ID, path: "AGENTS.md" },
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
    warning(["AGENTS.md"]);
    const promote = screen.getByTestId("instruction-drift-promote");
    await userEvent.click(promote);
    expect(promote).toHaveTextContent("Promoting");
    expect(promote).toBeDisabled();
    await userEvent.click(promote);
    expect(actions.promoteInstructionToSteering).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: { proposalId: "stp_7a8b9c" } });
    expect(
      await screen.findByTestId("instruction-drift-promoted"),
    ).toBeInTheDocument();
  });

  it("names the capability a deployment has not registered, and keeps the button (negative)", async () => {
    actions.promoteInstructionToSteering.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "tool_not_registered",
    });
    warning(["AGENTS.md"]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-failure"),
    ).toHaveTextContent(
      "This deployment does not run promote_instruction_to_steering yet, so Oxagen changed nothing.",
    );
    expect(screen.queryByTestId("instruction-drift-promoted")).toBeNull();
    expect(screen.getByTestId("instruction-drift-promote")).toBeEnabled();
  });

  it("says the promotion went unanswered when the call threw (negative)", async () => {
    actions.promoteInstructionToSteering.mockRejectedValue(
      new Error("network down"),
    );
    warning(["AGENTS.md"]);
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
      .mockResolvedValueOnce({ ok: true, value: { proposalId: "stp_1d2e3f" } });
    warning(["AGENTS.md"]);
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-failure"),
    ).toHaveTextContent("github_down");
    await userEvent.click(screen.getByTestId("instruction-drift-promote"));
    expect(
      await screen.findByTestId("instruction-drift-promoted"),
    ).toHaveTextContent("stp_1d2e3f");
    expect(screen.queryByTestId("instruction-drift-failure")).toBeNull();
  });
});
