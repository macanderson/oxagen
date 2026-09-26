// @vitest-environment jsdom
// "Steer the fleet" (fleet.md, Header): every agent selected by default with
// All and None, the steering text, the Delivery block whose Interrupt switch
// is offered where a selected run can be cut and disabled with the reason
// where none can (#2953), the footer summary, and the receipt the send
// answers, with an axe check in every case.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { RunRow } from "@/data/contracts/runs";
import { runRow } from "./fleet.builders";

const { steerFleet, refresh, deliveryReport } = vi.hoisted(() => ({
  steerFleet: vi.fn(),
  refresh: vi.fn(),
  deliveryReport: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
vi.mock("./actions", () => ({ steerFleet }));
// The delivery report is the Run page's dialog, tested in its own file. Here
// the receipt is checked for the query it hands the report.
vi.mock("@/features/run/client", () => ({
  DeliveryReport: (props: { query: unknown; testId?: string }) => {
    deliveryReport(props);
    return (
      <button type="button" data-testid={`${props.testId}-open`}>
        Delivery report
      </button>
    );
  },
}));

const { SteerFleetDialog } = await import("./steer-fleet");

const AGENTS = [
  { agentKey: "acme.core.release-bot" },
  { agentKey: "acme.core.docs" },
];
const RUNS: RunRow[] = [
  runRow({
    id: "tse_live",
    source: "tacho",
    agentKey: "acme.core.release-bot",
    turns: 12,
  }),
  runRow({
    id: "arun_done",
    agentKey: "acme.core.docs",
    status: "sealed",
    outcome: "completed",
  }),
];

/** The release bot's run in flight on the gateway tier, whose proxy can cut a call. */
const GATEWAY_RUNS: RunRow[] = [
  runRow({
    id: "tse_live",
    source: "tacho",
    agentKey: "acme.core.release-bot",
    turns: 12,
    enforcementTier: "gateway",
  }),
  RUNS[1] as RunRow,
];

function renderDialog(
  over: Partial<Parameters<typeof SteerFleetDialog>[0]> = {},
) {
  const onClose = vi.fn();
  render(
    <IntlProvider>
      <SteerFleetDialog
        org="acme"
        ws="core-platform"
        workspace="Core platform"
        agents={AGENTS}
        agentsRead
        agentTotal={AGENTS.length}
        agentsComplete
        runs={RUNS}
        parkedRunIds={[]}
        canCommand
        onClose={onClose}
        {...over}
      />
    </IntlProvider>,
  );
  return { onClose };
}

const dialog = () => screen.getByRole("dialog", { name: "Steer the fleet" });
const picker = () => screen.getByTestId("steer-agents");
const box = () => within(picker()).getByRole("combobox");
/** The agent keys the picker holds, in its chip order. */
const chips = () =>
  [...picker().querySelectorAll("[data-chip]")].map((chip) =>
    chip.getAttribute("data-chip"),
  );
/** The option row the open picker draws for `agentKey`. */
const option = (agentKey: string) =>
  screen
    .getAllByRole("option")
    .find((row) => row.getAttribute("data-value") === agentKey);
const send = () => screen.getByRole("button", { name: "Steer" });

beforeEach(() => {
  steerFleet.mockReset();
  refresh.mockReset();
  deliveryReport.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Steer the fleet", () => {
  it("selects every agent by default and shows what each has in flight", () => {
    renderDialog();
    expect(screen.getByTestId("steer-selected")).toHaveTextContent(
      "Agents · 2 of 2 selected",
    );
    expect(box()).toHaveAccessibleName("Agents · 2 of 2 selected");
    expect(chips()).toEqual(["acme.core.release-bot", "acme.core.docs"]);
    fireEvent.focus(box());
    const release = option("acme.core.release-bot");
    expect(release).toHaveAttribute("aria-selected", "true");
    expect(release).toHaveTextContent(
      "in flight · tse_live · turn 12 · Cut the 3.2 release branch",
    );
    // A sealed run is not in flight, so the agent is idle.
    expect(option("acme.core.docs")).toHaveTextContent(
      "no run in flight · reads this at its next run",
    );
    expect(dialog()).toHaveTextContent(
      "Every agent in Core platform, selected by default.",
    );
    // The summary sits in the footer beside Cancel and Steer, as the design has it.
    const summary = screen.getByTestId("steer-summary");
    expect(summary).toHaveTextContent(
      "2 agents · 1 in flight · at the boundary",
    );
    expect(summary.closest("[data-sheet-footer]")).not.toBeNull();
  });

  it("says idle agents read the steer at their next run", () => {
    renderDialog();
    const mode = screen.getByTestId("steer-mode");
    expect(mode).toHaveTextContent("At the boundary");
    expect(mode).toHaveTextContent(
      "Nothing in flight is cut. Idle agents read it at their next run.",
    );
  });

  it("keeps Interrupt disabled and says why when no selected run can be cut (negative)", () => {
    // The live run is on the harness tier, whose hook cannot cut a call.
    renderDialog();
    const interrupt = screen.getByRole("switch", { name: "Interrupt" });
    expect(interrupt).toBeDisabled();
    expect(interrupt).toHaveAttribute("aria-checked", "false");
    expect(interrupt).toHaveAccessibleDescription(
      "No selected run in flight is on the gateway or contained tier, where a call in flight can be cut.",
    );
    expect(screen.getByTestId("steer-mode")).toHaveTextContent(
      "At the boundary",
    );
  });

  it("keeps Interrupt disabled when no selected agent has a run in flight (negative)", () => {
    renderDialog({ runs: [RUNS[1] as RunRow] });
    const interrupt = screen.getByRole("switch", { name: "Interrupt" });
    expect(interrupt).toBeDisabled();
    expect(interrupt).toHaveAccessibleDescription(
      "No selected agent has a wrapped run in flight to interrupt.",
    );
  });

  it("does not count a gateway run its host no longer reaches, or a ledger run (negative)", () => {
    renderDialog({
      runs: [
        runRow({
          id: "tse_quiet",
          source: "tacho",
          agentKey: "acme.core.release-bot",
          enforcementTier: "gateway",
          commandBlock: "host_offline",
        }),
        // A steer to an agent reaches its wrapped runs, never a ledger run.
        runRow({
          id: "arun_gateway",
          source: "ledger",
          agentKey: "acme.core.docs",
          enforcementTier: "gateway",
        }),
      ],
    });
    expect(screen.getByRole("switch", { name: "Interrupt" })).toBeDisabled();
  });

  it("offers Interrupt where a selected run is on the gateway tier and sends interrupt as the ceiling", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_1", "tcm_2"], refused: [] },
    });
    renderDialog({ runs: GATEWAY_RUNS });
    const interrupt = screen.getByRole("switch", { name: "Interrupt" });
    expect(interrupt).toBeEnabled();
    expect(interrupt).toHaveAccessibleDescription(
      "1 selected agent has a run that can be cut",
    );
    const user = userEvent.setup();
    await user.click(interrupt);
    expect(interrupt).toHaveAttribute("aria-checked", "true");
    const mode = screen.getByTestId("steer-mode");
    expect(mode).toHaveTextContent("Interrupt now");
    expect(mode).toHaveTextContent(
      "A run on the gateway or contained tier has its call in flight cut, then reads this.",
    );
    expect(screen.getByTestId("steer-summary")).toHaveTextContent(
      "2 agents · 1 in flight · interrupt",
    );
    await user.type(screen.getByLabelText("Steering text"), "Stop now.");
    await user.click(screen.getByRole("button", { name: "Send & Interrupt" }));
    expect(steerFleet).toHaveBeenCalledWith("acme", "core-platform", {
      agentKeys: ["acme.core.release-bot", "acme.core.docs"],
      text: "Stop now.",
      requestedMode: "interrupt",
    });
  });

  it("counts a contained run as one that can be cut", () => {
    renderDialog({
      runs: [
        runRow({
          id: "tse_box",
          source: "tacho",
          agentKey: "acme.core.docs",
          enforcementTier: "contained",
        }),
      ],
    });
    expect(screen.getByRole("switch", { name: "Interrupt" })).toBeEnabled();
  });

  it("turns Interrupt off when the selection loses its last run that can be cut", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_1"], refused: [] },
    });
    renderDialog({ runs: GATEWAY_RUNS });
    const user = userEvent.setup();
    const interrupt = screen.getByRole("switch", { name: "Interrupt" });
    await user.click(interrupt);
    await user.click(
      screen.getByRole("button", { name: "Remove acme.core.release-bot" }),
    );
    expect(interrupt).toBeDisabled();
    expect(interrupt).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("steer-summary")).toHaveTextContent(
      "1 agent · 0 in flight · at the boundary",
    );
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(send());
    expect(steerFleet).toHaveBeenCalledWith("acme", "core-platform", {
      agentKeys: ["acme.core.docs"],
      text: "Hold.",
      requestedMode: "turn_boundary",
    });
  });

  it("clears and restores the selection with None and All, and cannot send to nobody", async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByTestId("steer-selected")).toHaveTextContent(
      "Agents · 0 of 2 selected",
    );
    expect(send()).toBeDisabled();
    expect(chips()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(send()).toBeEnabled();
    expect(chips()).toEqual(["acme.core.release-bot", "acme.core.docs"]);
    await user.click(
      screen.getByRole("button", { name: "Remove acme.core.docs" }),
    );
    expect(screen.getByTestId("steer-summary")).toHaveTextContent(
      "1 agent · 1 in flight · at the boundary",
    );
  });

  it("picks an agent by typing part of its key and steers only the picked", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: { commandIds: [], refused: [] },
    });
    renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "None" }));
    await user.click(box());
    await user.keyboard("docs");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(chips()).toEqual(["acme.core.docs"]);
    expect(screen.getByTestId("steer-selected")).toHaveTextContent(
      "Agents · 1 of 2 selected",
    );
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(send());
    expect(steerFleet).toHaveBeenCalledWith("acme", "core-platform", {
      agentKeys: ["acme.core.docs"],
      text: "Hold.",
      requestedMode: "turn_boundary",
    });
  });

  it("sends the text to the selected agents and shows what it reached", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: {
        commandIds: ["tcm_1"],
        refused: [{ agentKey: "acme.core.docs", code: "host_offline" }],
      },
    });
    renderDialog();
    const user = userEvent.setup();
    expect(send()).toBeDisabled();
    await user.type(
      screen.getByLabelText("Steering text"),
      "Skip the mobile repo this cycle.",
    );
    await user.click(send());
    expect(steerFleet).toHaveBeenCalledWith("acme", "core-platform", {
      agentKeys: ["acme.core.release-bot", "acme.core.docs"],
      text: "Skip the mobile repo this cycle.",
      requestedMode: "turn_boundary",
    });
    const receipt = await screen.findByTestId("steer-receipt");
    // The count is commands: one per run in flight, one per idle agent.
    expect(receipt).toHaveTextContent("Steer queued as 1 command.");
    expect(receipt).toHaveTextContent(
      "A run in flight takes its command at its next boundary. An idle agent's command waits for its next run.",
    );
    expect(receipt).toHaveTextContent(
      "1 agent refused the steer: acme.core.docs (host_offline).",
    );
    expect(refresh).toHaveBeenCalled();
    expect(
      within(dialog()).queryByRole("button", { name: "Steer" }),
    ).toBeNull();
  });

  it("opens the delivery report for the command ids the send returned", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: { commandIds: ["tcm_1", "tcm_2"], refused: [] },
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(send());
    const receipt = await screen.findByTestId("steer-receipt");
    expect(within(receipt).getByTestId("steer-report-open")).toHaveTextContent(
      "Delivery report",
    );
    expect(deliveryReport).toHaveBeenCalledWith(
      expect.objectContaining({
        org: "acme",
        ws: "core-platform",
        query: { commandIds: ["tcm_1", "tcm_2"] },
        testId: "steer-report",
      }),
    );
  });

  it("says when nothing took the steer, and offers no report of nothing (negative)", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: { commandIds: [], refused: [] },
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(send());
    const receipt = await screen.findByTestId("steer-receipt");
    expect(receipt).toHaveTextContent("Nothing took this steer.");
    expect(receipt).toHaveTextContent(
      "No selected agent has a run in flight or an enrolled host.",
    );
    expect(receipt).not.toHaveTextContent("An idle agent's command");
    expect(within(receipt).queryByTestId("steer-report-open")).toBeNull();
    expect(deliveryReport).not.toHaveBeenCalled();
  });

  it("names the refusal, not a missing host, when nothing took the steer because an agent refused it", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: {
        commandIds: [],
        refused: [{ agentKey: "acme.core.docs", code: "host_offline" }],
      },
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(send());
    const receipt = await screen.findByTestId("steer-receipt");
    expect(receipt).toHaveTextContent("Nothing took this steer.");
    expect(receipt).toHaveTextContent(
      "1 agent refused the steer: acme.core.docs (host_offline).",
    );
    expect(receipt).not.toHaveTextContent("an enrolled host");
  });

  it("names a refusal and keeps the form (negative)", async () => {
    steerFleet.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(send());
    expect(await screen.findByTestId("steer-failure")).toHaveTextContent(
      "This needs an organization Owner or Admin role.",
    );
    expect(screen.getByLabelText("Steering text")).toHaveValue("Hold.");
  });

  it("says why a viewer without the role cannot send (negative)", async () => {
    renderDialog({ canCommand: false });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    expect(screen.getByTestId("steer-role")).toHaveTextContent(
      "Sending a command needs",
    );
    expect(send()).toBeDisabled();
  });

  it("says why the list is empty when the agents could not be read (negative)", () => {
    renderDialog({ agents: [], agentsRead: false, agentTotal: null });
    expect(dialog()).toHaveTextContent(
      "The workspace's agents could not be read, so there is nobody to pick.",
    );
  });

  it("reads a parked run as parked for approval, not live", () => {
    renderDialog({ parkedRunIds: ["tse_live"] });
    fireEvent.focus(box());
    expect(option("acme.core.release-bot")).toHaveTextContent(
      "parked for approval · tse_live · turn 12",
    );
  });

  it("counts the workspace's agents, not the ones listed, and says which a steer cannot reach", () => {
    renderDialog({ agentTotal: 3 });
    expect(screen.getByTestId("steer-selected")).toHaveTextContent(
      "Agents · 2 of 3 selected",
    );
    expect(screen.getByTestId("steer-unlisted")).toHaveTextContent(
      "1 agent carries no key, so a steer cannot reach it.",
    );
  });

  it("says where the list stopped when the roster is incomplete (negative)", () => {
    renderDialog({ agentTotal: 64, agentsComplete: false });
    expect(screen.getByTestId("steer-unlisted")).toHaveTextContent(
      "The list stops after 2 agents. 62 more are not listed, so a steer does not reach them.",
    );
  });

  it("draws no unlisted line when every agent is listed", () => {
    renderDialog();
    expect(screen.queryByTestId("steer-unlisted")).toBeNull();
  });

  it("closes from the header's x, labelled Close", async () => {
    const { onClose } = renderDialog();
    const user = userEvent.setup();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest("[data-sheet-header]")).not.toBeNull();
    await user.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it("gives All and None the phone's touch target", () => {
    renderDialog();
    for (const name of ["All", "None"])
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "data-touch-target",
      );
  });

  it("closes on Cancel", async () => {
    const { onClose } = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
