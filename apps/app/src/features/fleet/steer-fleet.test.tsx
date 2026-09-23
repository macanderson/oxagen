// @vitest-environment jsdom
// "Steer the fleet" (fleet.md, Header): every agent selected by default with
// All and None, the steering text, the Delivery block whose Interrupt switch is
// disabled and says it is not yet available, the footer summary, and the
// receipt the send answers, with an axe check in every case.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runRow } from "./fleet.builders";

const { steerFleet, refresh } = vi.hoisted(() => ({
  steerFleet: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
vi.mock("./actions", () => ({ steerFleet }));

const { SteerFleetDialog } = await import("./steer-fleet");

const AGENTS = [
  { agentKey: "acme.core.release-bot" },
  { agentKey: "acme.core.docs" },
];
const RUNS = [
  runRow({ id: "tse_live", agentKey: "acme.core.release-bot", turns: 12 }),
  runRow({
    id: "arun_done",
    agentKey: "acme.core.docs",
    status: "sealed",
    outcome: "completed",
  }),
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
        runs={RUNS}
        canCommand
        onClose={onClose}
        {...over}
      />
    </IntlProvider>,
  );
  return { onClose };
}

const dialog = () => screen.getByRole("dialog", { name: "Steer the fleet" });
const send = () => screen.getByRole("button", { name: "Steer" });

beforeEach(() => {
  steerFleet.mockReset();
  refresh.mockReset();
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
    const release = screen.getByRole("checkbox", {
      name: "Steer acme.core.release-bot",
    });
    expect(release).toBeChecked();
    expect(release.closest("label")).toHaveTextContent(
      "tse_live · turn 12 · Cut the 3.2 release branch",
    );
    // A sealed run is not in flight, so the agent is idle.
    expect(
      screen
        .getByRole("checkbox", { name: "Steer acme.core.docs" })
        .closest("label"),
    ).toHaveTextContent("no run in flightidle");
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

  it("draws the Interrupt switch disabled and says it is not yet available", () => {
    renderDialog();
    const interrupt = screen.getByRole("switch", { name: "Interrupt" });
    expect(interrupt).toBeDisabled();
    expect(interrupt).toHaveAttribute("aria-checked", "false");
    expect(interrupt).toHaveAccessibleDescription("not yet available");
    expect(dialog()).toHaveTextContent("At the boundary");
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
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(send()).toBeEnabled();
    await user.click(
      screen.getByRole("checkbox", { name: "Steer acme.core.docs" }),
    );
    expect(screen.getByTestId("steer-summary")).toHaveTextContent(
      "1 agent · 1 in flight · at the boundary",
    );
  });

  it("sends the text to the selected agents and shows what it reached", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: {
        commandIds: ["tcm_1"],
        refused: [{ agentKey: "acme.core.docs", code: "observe_tier" }],
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
    });
    const receipt = await screen.findByTestId("steer-receipt");
    expect(receipt).toHaveTextContent("Steer queued for 1 run in flight.");
    expect(receipt).toHaveTextContent(
      "1 agent refused the steer: acme.core.docs (observe_tier).",
    );
    expect(refresh).toHaveBeenCalled();
    expect(
      within(dialog()).queryByRole("button", { name: "Steer" }),
    ).toBeNull();
  });

  it("says when no run in flight took the steer", async () => {
    steerFleet.mockResolvedValue({
      ok: true,
      value: { commandIds: [], refused: [] },
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steering text"), "Hold.");
    await user.click(send());
    expect(await screen.findByTestId("steer-receipt")).toHaveTextContent(
      "No run in flight took this steer.",
    );
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
    renderDialog({ agents: [], agentsRead: false });
    expect(dialog()).toHaveTextContent(
      "The workspace's agents could not be read, so there is nobody to pick.",
    );
  });

  it("closes on Cancel", async () => {
    const { onClose } = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
