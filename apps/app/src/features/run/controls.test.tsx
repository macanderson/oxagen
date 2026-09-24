// @vitest-environment jsdom
// The run controls and the record writes as a person drives them: open the
// dialog, submit it, and read what came back.
//
// The rule these hold is that the interface never claims more than the control
// plane did. `dispatch_command` queues a command, so a completed submit says
// queued and prints the command ids; it never says the run stopped. A refusal
// names the handler's own reason and leaves the dialog open with nothing
// changed.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  haltRun,
  steerRun,
  summarizeRun,
  exportRun,
  readRunExport,
  replace,
  refresh,
} = vi.hoisted(() => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./actions", () => ({
  haltRun,
  steerRun,
  summarizeRun,
  exportRun,
  readRunExport,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh }),
}));

const { RunControls } = await import("./run-controls");
const { ExportAction, SummarizeAction } = await import("./record-actions");

const RUN = "tse_7k2m9q";

function renderControls() {
  return render(
    <IntlProvider>
      <RunControls
        org="acme"
        ws="core-platform"
        runId={RUN}
        status="live"
        source="tacho"
        enforcementTier="harness"
        orgRole="member"
        wsRole="member"
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  for (const fn of [
    haltRun,
    steerRun,
    summarizeRun,
    exportRun,
    readRunExport,
    replace,
    refresh,
  ]) {
    fn.mockReset();
  }
});

afterEach(cleanup);

describe("run controls", () => {
  it("queues a pause with the reason typed and prints the command ids, never that the run stopped", async () => {
    haltRun.mockResolvedValue({ ok: true, value: { commandIds: ["tcm_1"] } });
    const user = userEvent.setup();
    const { container } = renderControls();
    await user.click(screen.getByTestId("run-pause"));
    // The open dialog is the state worth checking: the closed row is a button
    // list, and the labelled field and the status region only exist here.
    await expectNoAxe(container);
    await user.type(screen.getByLabelText("Reason"), "releasing 3.2");
    await user.click(screen.getByRole("button", { name: "Queue the pause" }));
    await waitFor(() => {
      expect(screen.getByTestId("queued-command")).toHaveTextContent("tcm_1");
    });
    expect(haltRun).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      RUN,
      "pause",
      "releasing 3.2",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "takes effect at the next boundary",
    );
  });

  it("says no live run took a command the control plane queued for nobody (negative)", async () => {
    haltRun.mockResolvedValue({ ok: true, value: { commandIds: [] } });
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("run-cancel"));
    await user.click(screen.getByRole("button", { name: "Cancel the run" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "No live run took this command.",
      );
    });
    expect(screen.queryByTestId("queued-command")).toBeNull();
  });

  it("sends the steer text at the default delivery mode and says it reaches the model at the next delivery point", async () => {
    steerRun.mockResolvedValue({ ok: true, value: { commandIds: ["tcm_9"] } });
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("run-steer"));
    await user.type(
      screen.getByLabelText("What to tell the agent"),
      "use the 3.2 branch",
    );
    // The contract's own default, offered checked so a person who does not
    // choose sends the mode every connection point can carry.
    expect(screen.getByTestId("steer-mode-next_step")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Send it" }));
    await waitFor(() => {
      expect(screen.getByTestId("queued-command")).toHaveTextContent("tcm_9");
    });
    expect(steerRun).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      RUN,
      "use the 3.2 branch",
      "next_step",
    );
  });

  it("carries the delivery mode the person picked, and says what each one costs the run in flight", async () => {
    steerRun.mockResolvedValue({ ok: true, value: { commandIds: ["tcm_9"] } });
    const user = userEvent.setup();
    const { container } = renderControls();
    await user.click(screen.getByTestId("run-steer"));
    await expectNoAxe(container);
    for (const mode of ["next_step", "interrupt", "turn_boundary"]) {
      expect(screen.getByTestId(`steer-mode-${mode}`)).toBeTruthy();
    }
    expect(
      screen.getByText(/cut short so your text lands sooner/),
    ).toBeTruthy();
    await user.click(screen.getByTestId("steer-mode-interrupt"));
    await user.type(
      screen.getByLabelText("What to tell the agent"),
      "stop and read the failing job",
    );
    await user.click(screen.getByRole("button", { name: "Send it" }));
    await waitFor(() => {
      expect(screen.getByTestId("queued-command")).toBeTruthy();
    });
    expect(steerRun).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      RUN,
      "stop and read the failing job",
      "interrupt",
    );
  });

  it("names a delivery mode the action refused and queues nothing (negative)", async () => {
    steerRun.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "delivery_mode",
      field: "requestedMode",
    });
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("run-steer"));
    await user.type(screen.getByLabelText("What to tell the agent"), "go on");
    await user.click(screen.getByRole("button", { name: "Send it" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-steer-failure")).toHaveTextContent(
        "Pick one of the three delivery modes.",
      );
    });
    expect(screen.queryByTestId("queued-command")).toBeNull();
  });

  it("offers no delivery mode on a halt, which the contract refuses a payload on (negative)", async () => {
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("run-pause"));
    expect(screen.queryByTestId("steer-mode-next_step")).toBeNull();
  });

  it("names the handler's own reason on a refusal and queues nothing (negative)", async () => {
    haltRun.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "run_sealed",
    });
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("run-pause"));
    await user.click(screen.getByRole("button", { name: "Queue the pause" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-pause-failure")).toHaveTextContent(
        "This run has ended, so nothing can receive the command.",
      );
    });
    expect(screen.queryByTestId("queued-command")).toBeNull();
  });

  it("names a write that threw before it answered rather than falling silent (negative)", async () => {
    haltRun.mockRejectedValue(new Error("socket hang up"));
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("run-resume"));
    await user.click(screen.getByRole("button", { name: "Queue the resume" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-resume-failure")).toHaveTextContent(
        "command_failed",
      );
    });
  });

  it("re-reads the run when the person asks, so the status is what says the agent obeyed", async () => {
    haltRun.mockResolvedValue({ ok: true, value: { commandIds: ["tcm_1"] } });
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("run-pause"));
    await user.click(screen.getByRole("button", { name: "Queue the pause" }));
    await waitFor(() => {
      expect(screen.getByTestId("queued-command")).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: "Re-read the run" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the durable ingress fence and disables repeat cancellation", () => {
    render(
      <IntlProvider>
        <RunControls
          org="acme"
          ws="core-platform"
          runId="arun_record1"
          status="live"
          source="ledger"
          enforcementTier="observe"
          ingressRevoked
          orgRole="owner"
          wsRole="owner"
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("run-cancel")).toBeDisabled();
    expect(screen.getByTestId("ledger-ingress-revoked")).toHaveTextContent(
      "external process may still be running",
    );
  });

  it.each([false, true])(
    "controls ledger ingress honestly, paused=%s",
    async (paused) => {
      haltRun.mockResolvedValue({
        ok: true,
        value: { commandIds: ["tcm_ingress"] },
      });
      const user = userEvent.setup();
      render(
        <IntlProvider>
          <RunControls
            org="acme"
            ws="core-platform"
            runId="arun_record1"
            status="live"
            source="ledger"
            enforcementTier="observe"
            ingressPaused={paused}
            orgRole="owner"
            wsRole="owner"
          />
        </IntlProvider>,
      );
      const command = paused ? "resume" : "pause";
      expect(
        screen.queryByTestId(`run-${paused ? "pause" : "resume"}`),
      ).toBeNull();
      expect(screen.getByTestId("run-steer")).toBeDisabled();
      if (paused)
        expect(screen.getByTestId("ledger-control-limit")).toHaveTextContent(
          "Evidence ingress is paused",
        );
      await user.click(screen.getByTestId(`run-${command}`));
      expect(screen.getByRole("dialog")).not.toHaveTextContent(
        "The agent carries on",
      );
      expect(screen.getByRole("dialog")).not.toHaveTextContent(
        "The model reads this on resume",
      );
      await user.click(
        screen.getByRole("button", {
          name: paused ? "Resume evidence ingress" : "Pause evidence ingress",
        }),
      );
      await waitFor(() => {
        expect(haltRun).toHaveBeenCalledWith(
          "acme",
          "core-platform",
          "arun_record1",
          command,
          "",
        );
      });
      expect(await screen.findByTestId("queued-command")).toHaveTextContent(
        "tcm_ingress",
      );
    },
  );

  it("cancels ledger ingress without claiming that the external process stopped", async () => {
    haltRun.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_cancel"] },
    });
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <RunControls
          org="acme"
          ws="core-platform"
          runId="arun_record1"
          status="live"
          source="ledger"
          enforcementTier="observe"
          orgRole="owner"
          wsRole="owner"
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("run-pause")).toBeEnabled();
    expect(screen.queryByTestId("run-resume")).toBeNull();
    expect(screen.getByTestId("run-steer")).toBeDisabled();
    expect(screen.getByTestId("run-cancel")).toBeEnabled();
    await user.click(screen.getByTestId("run-cancel"));
    expect(screen.getByTestId("run-cancel-dialog")).toHaveTextContent(
      "does not stop the external process",
    );
    await user.click(
      screen.getByRole("button", { name: "Cancel evidence ingress" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("queued-command")).toHaveTextContent(
        "tcm_cancel",
      ),
    );
    expect(screen.getByTestId("run-cancel-dialog")).toHaveTextContent(
      "external process may still be running",
    );
    expect(haltRun).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "arun_record1",
      "cancel",
      "",
    );
  });

  it("disables every control, with the reason, for a viewer dispatch_command would refuse (negative)", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <RunControls
          org="acme"
          ws="core-platform"
          runId={RUN}
          status="live"
          source="tacho"
          enforcementTier="harness"
          orgRole="viewer"
          wsRole="viewer"
        />
      </IntlProvider>,
    );
    for (const command of ["pause", "resume", "steer", "cancel"]) {
      expect(screen.getByTestId(`run-${command}`)).toBeDisabled();
    }
    expect(screen.getByTestId("role-no-control")).toHaveTextContent(
      "workspace Owner or Member role",
    );
    await user.click(screen.getByTestId("run-pause"));
    expect(screen.queryByTestId("run-pause-dialog")).toBeNull();
    expect(haltRun).not.toHaveBeenCalled();
  });

  // An observe-tier session records what an agent did and gives Oxagen no
  // connection point, so a queued command would have nowhere to travel. The
  // tier is read before the ledger and the role branches, because it holds
  // whatever those two say (#3285).
  it("disables every control, with the reason, on an observe-tier run (negative)", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <RunControls
          org="acme"
          ws="core-platform"
          runId={RUN}
          status="live"
          source="tacho"
          enforcementTier="observe"
          orgRole="owner"
          wsRole="owner"
        />
      </IntlProvider>,
    );
    for (const command of ["pause", "resume", "steer", "cancel"]) {
      expect(screen.getByTestId(`run-${command}`)).toBeDisabled();
    }
    expect(screen.getByTestId("observe-no-control")).toHaveTextContent(
      "Oxagen was never in the path of its calls, so there is no connection point to pause, steer or cancel.",
    );
    expect(screen.queryByTestId("ledger-no-control")).toBeNull();
    expect(screen.queryByTestId("role-no-control")).toBeNull();
    await user.click(screen.getByTestId("run-pause"));
    expect(screen.queryByTestId("run-pause-dialog")).toBeNull();
    expect(haltRun).not.toHaveBeenCalled();
    expect(steerRun).not.toHaveBeenCalled();
  });

  it("admits a workspace Member who is only an organization Viewer, as dispatch_command does", () => {
    render(
      <IntlProvider>
        <RunControls
          org="acme"
          ws="core-platform"
          runId={RUN}
          status="live"
          source="tacho"
          enforcementTier="harness"
          orgRole="viewer"
          wsRole="member"
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("run-pause")).not.toBeDisabled();
    expect(screen.queryByTestId("role-no-control")).toBeNull();
  });
});

describe("record writes", () => {
  function renderRecord(
    hasSummary: boolean,
    orgRole: "owner" | "member" | "viewer" = "owner",
    summarizable = true,
  ) {
    return render(
      <IntlProvider>
        <SummarizeAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed
          hasSummary={hasSummary}
          summarizable={summarizable}
          orgRole={orgRole}
        />
        <ExportAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed
          orgRole={orgRole}
        />
      </IntlProvider>,
    );
  }

  it("queues the summary and says it appears once the model has written it", async () => {
    summarizeRun.mockResolvedValue({ ok: true, value: { runId: RUN } });
    const user = userEvent.setup();
    renderRecord(false);
    await user.click(screen.getByTestId("run-summarize"));
    await user.click(screen.getByRole("button", { name: "Queue the summary" }));
    await waitFor(() => {
      expect(screen.getByTestId("queued-receipt")).toHaveTextContent(RUN);
    });
    expect(summarizeRun).toHaveBeenCalledWith("acme", "core-platform", RUN);
    expect(screen.getByRole("status")).toHaveTextContent(
      "once the model has written it",
    );
  });

  it("offers Summarize again when the run already carries one", () => {
    renderRecord(true);
    expect(screen.getByTestId("run-resummarize")).toHaveTextContent(
      "Summarize again",
    );
    expect(screen.queryByTestId("run-summarize")).toBeNull();
  });

  it("says a digest_only recording has nothing for a model to read (negative)", async () => {
    summarizeRun.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "digest_only",
    });
    const user = userEvent.setup();
    renderRecord(false);
    await user.click(screen.getByTestId("run-summarize"));
    await user.click(screen.getByRole("button", { name: "Queue the summary" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-summarize-failure")).toHaveTextContent(
        "kept digests and no bodies",
      );
    });
  });

  it("queues the export and prints its id", async () => {
    exportRun.mockResolvedValue({ ok: true, value: { exportId: "rexp_1" } });
    const user = userEvent.setup();
    renderRecord(true);
    await user.click(screen.getByTestId("run-export"));
    await user.click(screen.getByRole("button", { name: "Queue the bundle" }));
    await waitFor(() => {
      expect(screen.getByTestId("queued-receipt")).toHaveTextContent("rexp_1");
    });
  });

  it("draws Export disabled, with the reason, for a viewer export_run would refuse (negative)", async () => {
    const user = userEvent.setup();
    renderRecord(true, "member");
    const button = screen.getByTestId("run-export");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-reason", "export-no-role");
    expect(button.getAttribute("title")).toContain(
      "needs an organization Owner or Admin role",
    );
    await user.click(button);
    expect(screen.queryByTestId("run-export-dialog")).toBeNull();
    expect(exportRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("run-resummarize")).not.toBeDisabled();
  });

  it("draws Summarize disabled, with the reason, for an organization Viewer (negative)", () => {
    renderRecord(false, "viewer");
    expect(screen.getByTestId("run-summarize")).toBeDisabled();
    expect(screen.getByTestId("run-summarize")).toHaveAttribute(
      "data-reason",
      "summarize-no-role",
    );
    expect(screen.getByTestId("run-summarize").getAttribute("title")).toContain(
      "Owner, Admin or Member role",
    );
    expect(screen.getByTestId("run-export")).toBeDisabled();
  });

  it("offers no summary while the run is live, and draws Export disabled until it seals (negative)", () => {
    render(
      <IntlProvider>
        <SummarizeAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed={false}
          hasSummary={false}
          summarizable={false}
          orgRole="owner"
        />
        <ExportAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed={false}
          orgRole="owner"
        />
      </IntlProvider>,
    );
    expect(screen.queryByTestId("run-summarize")).toBeNull();
    expect(screen.getByTestId("run-export")).toBeDisabled();
    expect(screen.getByTestId("run-export").getAttribute("title")).toContain(
      "Export this run once it seals",
    );
  });
});
