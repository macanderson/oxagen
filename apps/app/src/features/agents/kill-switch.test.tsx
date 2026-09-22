// @vitest-environment jsdom
// The kill switch on an agent's page: the dialog requires a reason, calls
// `pauseAgent` for the agent and workspace named, and shows the pause outcome
// honestly — a count of runs paused, none live, no agent key to broadcast to,
// or the broadcast itself failing after the switch already took effect.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { pauseAgent } = vi.hoisted(() => ({ pauseAgent: vi.fn() }));
vi.mock("./actions", () => ({ pauseAgent }));

const { AgentKillSwitch } = await import("./kill-switch");

function renderSwitch(agentKey: string | null = "acme.core.release-bot") {
  render(
    <IntlProvider>
      <AgentKillSwitch
        org="acme"
        ws="core-platform"
        agentId="agt_releasebot"
        agentKey={agentKey}
        name="Release bot"
      />
    </IntlProvider>,
  );
}

async function open() {
  await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
  return screen.getByTestId("agent-kill-switch-dialog");
}

beforeEach(() => {
  pauseAgent.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("AgentKillSwitch", () => {
  it("refuses to submit with no reason, so no run is silently left unexplained", async () => {
    renderSwitch();
    const dialog = await open();
    const submit = within(dialog).getByRole("button", {
      name: "Stop this agent",
    });
    await userEvent.click(submit);
    expect(pauseAgent).not.toHaveBeenCalled();
  });

  it("stops the agent and reports how many live runs paused", async () => {
    pauseAgent.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_1",
        changed: true,
        denyGeneration: { org: 4, workspace: 9 },
        pause: { kind: "paused", commandIds: ["tcm_1", "tcm_2"] },
      },
    });
    renderSwitch();
    const dialog = await open();
    await userEvent.type(
      within(dialog).getByLabelText("Reason"),
      "Credential leaked in a public repo",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop this agent" }),
    );
    expect(pauseAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { agentId: "agt_releasebot", agentKey: "acme.core.release-bot" },
      "Credential leaked in a public repo",
    );
    expect(await screen.findByTestId("kill-switch-outcome")).toHaveTextContent(
      "2 live runs paused. Every new tool call is denied.",
    );
    expect(screen.queryByTestId("agent-kill-switch-unchanged")).toBeNull();
  });

  it("says the switch was already on when a second flip changes nothing, and still reports the pause", async () => {
    pauseAgent.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_1",
        changed: false,
        denyGeneration: { org: 4, workspace: 9 },
        pause: { kind: "no_live_runs" },
      },
    });
    renderSwitch();
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Retest");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop this agent" }),
    );
    expect(
      await screen.findByTestId("agent-kill-switch-unchanged"),
    ).toHaveTextContent("already on");
    expect(screen.getByTestId("kill-switch-outcome")).toHaveTextContent(
      "No run of this agent was live.",
    );
  });

  it("names an unenrolled agent's missing key rather than claiming it paused nothing live", async () => {
    pauseAgent.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_2",
        changed: true,
        denyGeneration: { org: 1, workspace: 1 },
        pause: { kind: "no_agent_key" },
      },
    });
    renderSwitch(null);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Testing");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop this agent" }),
    );
    expect(pauseAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { agentId: "agt_releasebot", agentKey: null },
      "Testing",
    );
    expect(await screen.findByTestId("kill-switch-outcome")).toHaveTextContent(
      "never had a live run",
    );
  });

  it("reports the switch took effect even when the pause broadcast itself failed (negative)", async () => {
    pauseAgent.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_3",
        changed: true,
        denyGeneration: { org: 2, workspace: 2 },
        pause: {
          kind: "failed",
          failure: { ok: false, reason: "denied", code: "org_role_required" },
        },
      },
    });
    renderSwitch();
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Testing");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop this agent" }),
    );
    const outcome = await screen.findByTestId("kill-switch-outcome");
    expect(outcome).toHaveTextContent("pausing its live runs failed");
    expect(outcome).toHaveTextContent(
      "Your organization role does not allow this change",
    );
  });

  it("names the refusal and writes nothing when the switch itself is denied", async () => {
    pauseAgent.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderSwitch();
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Testing");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop this agent" }),
    );
    expect(
      await screen.findByTestId("agent-kill-switch-failure"),
    ).toHaveTextContent("Your organization role does not allow this change");
    expect(screen.queryByTestId("kill-switch-outcome")).toBeNull();
  });
});
