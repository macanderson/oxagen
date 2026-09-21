// @vitest-environment jsdom
// The row controls on Fleet as a person drives them: open the dialog, confirm,
// and read what came back.
//
// The rule they hold is the run page's: the row never claims more than the
// control plane did. `dispatch_command` queues a command, so a completed
// submit says the pause is queued and points at the run's status; it never
// says the run paused. A refusal, and a command the control plane queued for
// nobody, both roll the optimistic marker back and leave the dialog open with
// the reason.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { dispatchRunCommand, refresh } = vi.hoisted(() => ({
  dispatchRunCommand: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  dispatchRunCommand,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

const { RunRowControls } = await import("./run-row-controls");

const RUN = "tse_7k2m9q";

type Props = Parameters<typeof RunRowControls>[0];

function renderRow(overrides: Partial<Props> = {}) {
  return render(
    <IntlProvider>
      <RunRowControls
        org="acme"
        ws="core-platform"
        runId={RUN}
        status="live"
        source="tacho"
        enforcementTier="harness"
        canCommand
        {...overrides}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  dispatchRunCommand.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe("run row controls", () => {
  it.each(["pause", "resume", "cancel"] as const)(
    "queues a %s with the reason typed, and says the status is what says the agent took it",
    async (command) => {
      dispatchRunCommand.mockResolvedValue({
        ok: true,
        value: { commandIds: ["tcm_1"] },
      });
      const user = userEvent.setup();
      renderRow();
      await user.click(screen.getByTestId(`row-${command}`));
      await user.type(screen.getByLabelText("Reason"), "releasing 3.2");
      await user.click(
        screen.getByRole("button", { name: /^(Queue the|Cancel the run)/ }),
      );
      await waitFor(() => {
        expect(screen.getByTestId("row-command-state")).toHaveTextContent(
          `The ${command} is queued.`,
        );
      });
      expect(dispatchRunCommand).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        RUN,
        command,
        "releasing 3.2",
      );
      expect(screen.getByTestId("row-command-state")).toHaveTextContent(
        "The run's status says when the agent has taken it.",
      );
    },
  );

  it("names each button with its run, and passes an axe check with the dialog open", async () => {
    const user = userEvent.setup();
    const { container } = renderRow();
    expect(
      screen.getByRole("button", { name: `Pause ${RUN}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: `Commands for ${RUN}` }),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("row-pause"));
    await expectNoAxe(container);
  });

  it("rolls the queued marker back and names the reason when the control plane refuses (negative)", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "run_sealed",
    });
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByTestId("row-pause"));
    await user.click(screen.getByRole("button", { name: "Queue the pause" }));
    await waitFor(() => {
      expect(screen.getByTestId("row-command-failure")).toHaveTextContent(
        "This run has ended, so nothing can receive the command.",
      );
      expect(screen.queryByTestId("row-command-state")).toBeNull();
    });
    expect(screen.getByTestId("row-pause-form")).toBeInTheDocument();
  });

  it("rolls back when the control plane queued the command for nobody (negative)", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: [] },
    });
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByTestId("row-cancel"));
    await user.click(screen.getByRole("button", { name: "Cancel the run" }));
    await waitFor(() => {
      expect(screen.getByTestId("row-command-failure")).toHaveTextContent(
        "No live run took this command.",
      );
      expect(screen.queryByTestId("row-command-state")).toBeNull();
    });
  });

  it("names a write that threw before it answered rather than falling silent (negative)", async () => {
    dispatchRunCommand.mockRejectedValue(new Error("socket hang up"));
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByTestId("row-resume"));
    await user.click(screen.getByRole("button", { name: "Queue the resume" }));
    await waitFor(() => {
      expect(screen.getByTestId("row-command-failure")).toHaveTextContent(
        "command_failed",
      );
      expect(screen.queryByTestId("row-command-state")).toBeNull();
    });
  });

  it("re-reads the table when the person asks, so the status is what says the agent obeyed", async () => {
    dispatchRunCommand.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_1"] },
    });
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByTestId("row-pause"));
    await user.click(screen.getByRole("button", { name: "Queue the pause" }));
    await waitFor(() => {
      expect(screen.getByTestId("row-reread")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("row-reread"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("draws no controls on a run that is not live (negative)", () => {
    const { container } = renderRow({ status: "sealed" });
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the recorded reason and no controls on an observe-tier run (negative)", () => {
    renderRow({ enforcementTier: "observe" });
    expect(screen.getByTestId("row-observe-no-control")).toHaveTextContent(
      "Oxagen was never in the path of its calls",
    );
    expect(screen.queryByTestId("row-pause")).toBeNull();
  });

  it("draws the recorded reason and no controls on a ledger run (negative)", () => {
    renderRow({ source: "ledger" });
    expect(screen.getByTestId("row-ledger-no-control")).toHaveTextContent(
      "steering needs a producer connection",
    );
    expect(screen.queryByTestId("row-cancel")).toBeNull();
  });

  it("puts the observe reason ahead of the ledger one, as the handler does (negative)", () => {
    renderRow({ source: "ledger", enforcementTier: "observe" });
    expect(screen.getByTestId("row-observe-no-control")).toBeInTheDocument();
    expect(screen.queryByTestId("row-ledger-no-control")).toBeNull();
  });

  it("draws the reason and no controls for a viewer dispatch_command would refuse (negative)", () => {
    renderRow({ canCommand: false });
    expect(screen.getByTestId("row-role-no-control")).toHaveTextContent(
      "workspace Owner or Member role",
    );
    expect(screen.queryByTestId("row-resume")).toBeNull();
  });
});
