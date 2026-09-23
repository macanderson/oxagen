// @vitest-environment jsdom
// The cost-center write on the identity tab (ADR-142): the dialog reads the
// organization's list when it opens, offers None and every label, submits
// the chosen label by the agent's slug, and reloads the agent's page once the
// write answers. A refusal is named in the dialog and nothing navigates.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, readCostCenters, setAgentCostCenter } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  readCostCenters: vi.fn(),
  setAgentCostCenter: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ readCostCenters, setAgentCostCenter }));

const { ChargeAgent } = await import("./cost-center-controls");
type CostCenterTarget = import("./cost-center-controls").CostCenterTarget;

const TARGET: CostCenterTarget = {
  org: "acme",
  ws: "core-platform",
  agentSlug: "release-bot",
  agentName: "Release bot",
  costCenter: null,
};
const HERE = routes.agent("acme", "core-platform", "release-bot", {
  tab: "identity",
});
const CENTERS = [
  { id: "cct_eng", label: "ENG-1001" },
  { id: "cct_ops", label: "OPS-2" },
];

function renderCharge(over: Partial<CostCenterTarget> = {}) {
  render(
    <IntlProvider>
      <ChargeAgent {...TARGET} {...over} />
    </IntlProvider>,
  );
}

async function open() {
  await userEvent.click(
    screen.getByRole("button", { name: "Change cost center" }),
  );
  return screen.getByTestId("agent-cost-center");
}

beforeEach(() => {
  router.replace.mockReset();
  readCostCenters.mockReset();
  setAgentCostCenter.mockReset();
  readCostCenters.mockResolvedValue({ ok: true, value: CENTERS });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("ChargeAgent", () => {
  it("reads the list when it opens and charges the agent to the chosen label", async () => {
    setAgentCostCenter.mockResolvedValue({
      ok: true,
      value: { costCenter: "OPS-2" },
    });
    renderCharge();
    expect(readCostCenters).not.toHaveBeenCalled();
    const dialog = await open();
    expect(readCostCenters).toHaveBeenCalledWith("acme", "core-platform");
    expect(dialog).toHaveTextContent("Cost center for Release bot");
    const picker = await within(dialog).findByLabelText("Cost center");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["None (inherit the workspace's)", "ENG-1001", "OPS-2"]);
    await userEvent.selectOptions(picker, "OPS-2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(setAgentCostCenter).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "release-bot",
      "OPS-2",
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
  });

  it("opens on the label the agent holds and clears it with None", async () => {
    setAgentCostCenter.mockResolvedValue({
      ok: true,
      value: { costCenter: null },
    });
    renderCharge({ costCenter: "ENG-1001" });
    const dialog = await open();
    const picker = await within(dialog).findByLabelText("Cost center");
    expect(picker).toHaveValue("ENG-1001");
    await userEvent.selectOptions(picker, "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(setAgentCostCenter).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "release-bot",
      "",
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
  });

  it("says the organization has no cost center and offers no save (negative)", async () => {
    readCostCenters.mockResolvedValue({ ok: true, value: [] });
    renderCharge();
    const dialog = await open();
    await within(dialog).findByText(
      "This organization has no cost centers. Add one on the Organization page, then charge this agent to it here.",
    );
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(dialog).queryByLabelText("Cost center")).toBeNull();
  });

  it("names a refused list read in the dialog (negative)", async () => {
    readCostCenters.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderCharge();
    const dialog = await open();
    const alert = await within(dialog).findByTestId(
      "agent-cost-center-list-failure",
    );
    expect(alert).toHaveTextContent(
      "Your organization role does not allow this change.",
    );
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("names a refused write and stays open (negative)", async () => {
    setAgentCostCenter.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderCharge();
    const dialog = await open();
    const picker = await within(dialog).findByLabelText("Cost center");
    await userEvent.selectOptions(picker, "ENG-1001");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByTestId(
      "agent-cost-center-failure",
    );
    expect(alert).toHaveTextContent(
      "Your organization role does not allow this change.",
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("agent-cost-center")).toBeInTheDocument();
  });

  it("names a write that never answered (negative)", async () => {
    setAgentCostCenter.mockRejectedValue(new Error("socket closed"));
    renderCharge();
    const dialog = await open();
    await within(dialog).findByLabelText("Cost center");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByTestId("agent-cost-center-failure"),
    ).toHaveTextContent("action_failed");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a list read that never answered (negative)", async () => {
    readCostCenters.mockRejectedValue(new Error("socket closed"));
    renderCharge();
    const dialog = await open();
    expect(
      await within(dialog).findByTestId("agent-cost-center-list-failure"),
    ).toHaveTextContent("action_failed");
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
  });
});
