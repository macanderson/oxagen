// @vitest-environment jsdom
// Spend › Budgets › Gateway sessions, with its action faked.
//
// Five behaviours are load-bearing and each is asserted rather than left to
// reading the component:
//
//   1. Enforced with nothing to enforce is refused in the form, and no
//      capability runs. A switch that says it governs and governs nothing is
//      the defect the gateway audit found; the dialog must not be the place
//      it comes back.
//   2. A model pattern the host could not apply is refused, on the field that
//      holds it, so the person knows which box to fix.
//   3. A saved policy that reaches no machine says so. A model list rides a
//      gated bundle field, so "saved" and "in force" are different answers
//      and the panel gives the second one.
//   4. A blank allowlist box is no allowlist, not an empty one.
//   5. A reader who cannot write sees the policy and no form.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayPolicy } from "@/data/contracts/spend";
import { expectNoAxe } from "@/test/expect-no-axe";
import spend from "../../../messages/spend.json";
import ui from "../../../messages/ui.json";

const setGatewayPolicyAction = vi.fn();
vi.mock("./actions", () => ({ setGatewayPolicyAction }));

const { GatewayPolicySection } = await import("./gateway-policy");

const at = { org: "acme", ws: "core-platform" };

const OBSERVED: GatewayPolicy = {
  mode: "observed",
  sessionLimit: null,
  sessionLimitUsd: null,
  modelAllow: null,
  modelDeny: [],
};

function renderWithIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ ...spend, ...ui }}
      timeZone="UTC"
    >
      {node}
    </NextIntlClientProvider>,
  );
}

function renderSection(policy: GatewayPolicy = OBSERVED, canEdit = true) {
  return renderWithIntl(
    <GatewayPolicySection at={at} policy={policy} canEdit={canEdit} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setGatewayPolicyAction.mockResolvedValue({
    ok: true,
    value: { hosts: 2, hostsEnforcingModels: 2 },
  });
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the gateway policy section", () => {
  it("offers no mode switch and says the policy is not applied", () => {
    // Nothing reads this policy: no bundle carries a `models` clause and the
    // handler refuses `enforced`. A select that offered it would be a switch
    // for an enforcer that is not there.
    renderSection();
    expect(screen.queryByLabelText(/^Mode$/)).toBeNull();
    expect(
      screen.getByText(spend.spend.gateway.notApplied),
    ).toBeTruthy();
  });

  it("refuses a model pattern the host could not apply, on its own field", async () => {
    const user = userEvent.setup();
    renderSection();
    // A star in the middle reads like a glob and is not one, so it would
    // silently match nothing if it were saved.
    await user.type(
      screen.getByLabelText(spend.spend.gateway.modelAllow),
      "claude-*-5",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    expect(
      await screen.findByText(spend.spend.gateway.errors.modelPatternInvalid),
    ).toBeTruthy();
    expect(setGatewayPolicyAction).not.toHaveBeenCalled();
  });

  it("sends a blank allowlist as null and a filled one as a list", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText(spend.spend.gateway.sessionLimit),
      "25",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    await waitFor(() => {
      expect(setGatewayPolicyAction).toHaveBeenCalledWith(at, {
        mode: "observed",
        sessionLimit: "25",
        modelAllow: "",
        modelDeny: "",
      });
    });
  });

  it("says a saved list reaches no enrolled machine", async () => {
    // The whole reason the write returns reach: no bundle carries a `models`
    // clause, so every enrolled host keeps calling any model it likes. A
    // footer that reported only the save would read as an applied policy.
    setGatewayPolicyAction.mockResolvedValue({
      ok: true,
      value: { hosts: 3, hostsEnforcingModels: 1 },
    });
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText(spend.spend.gateway.modelDeny),
      "gpt-4o",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    const reach = await screen.findByTestId("gateway-reach");
    expect(reach.textContent).toContain("3");
    expect(reach.textContent).toMatch(/none of them reads these lists yet/i);
  });

  it("reports a refusal without claiming the policy changed", async () => {
    setGatewayPolicyAction.mockResolvedValue({ ok: false, reason: "denied" });
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText(spend.spend.gateway.sessionLimit),
      "10",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    expect(
      await screen.findByText(spend.spend.gateway.alert.denied),
    ).toBeTruthy();
    expect(screen.queryByTestId("gateway-reach")).toBeNull();
  });

  it("reports a saved policy that no machine is enrolled to apply", async () => {
    // Distinct from the stored case: zero hosts is not "none of them reads
    // the lists", it is a policy with nothing to apply it to at all, and one
    // sentence must not stand for both.
    setGatewayPolicyAction.mockResolvedValue({
      ok: true,
      value: { hosts: 0, hostsEnforcingModels: 0 },
    });
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText(spend.spend.gateway.sessionLimit),
      "10",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    const reach = await screen.findByTestId("gateway-reach");
    expect(reach.textContent).toBe(spend.spend.gateway.reach.none);
  });

  it("puts a field refusal from the server on that field, not in the alert", async () => {
    // The contract parses the input again on every invoke, so a value the
    // form let through can still be refused. It has to land on the field a
    // person can fix rather than as a whole-form failure.
    setGatewayPolicyAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "modelPatternInvalid",
      field: "modelDeny",
    });
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText(spend.spend.gateway.modelDeny),
      "gpt-4o",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    expect(
      await screen.findByText(spend.spend.gateway.errors.modelPatternInvalid),
    ).toBeTruthy();
    expect(screen.queryByText(spend.spend.gateway.alert.failed)).toBeNull();
  });

  it("reports a thrown action as failed rather than losing it", async () => {
    // A rejected server action is not a refusal, and swallowing it would
    // leave the panel looking as though nothing was submitted.
    setGatewayPolicyAction.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText(spend.spend.gateway.sessionLimit),
      "10",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    expect(
      await screen.findByText(spend.spend.gateway.alert.failed),
    ).toBeTruthy();
    expect(screen.queryByTestId("gateway-reach")).toBeNull();
  });

  it("reports a refusal that names no field and is not a denial", async () => {
    // Neither `invalid` with a field nor `denied`: an unclassified refusal
    // still has to say something, and the generic alert is that something.
    setGatewayPolicyAction.mockResolvedValue({ ok: false, reason: "failed" });
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText(spend.spend.gateway.sessionLimit),
      "10",
    );
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    expect(
      await screen.findByText(spend.spend.gateway.alert.failed),
    ).toBeTruthy();
  });

  it("sends observed for a row that still reads enforced", async () => {
    // A row written before `enforced` was refused still says so. The form
    // sends `observed` whatever the row holds, so saving an old policy cannot
    // rewrite the mode nothing reads back into the record.
    const user = userEvent.setup();
    renderSection({
      mode: "enforced",
      sessionLimit: { micros: "5000000", currency: "USD" },
      sessionLimitUsd: 5,
      modelAllow: null,
      modelDeny: [],
    });
    await user.click(screen.getByRole("button", { name: /save the policy/i }));
    await waitFor(() => {
      expect(setGatewayPolicyAction).toHaveBeenCalledWith(
        at,
        expect.objectContaining({ mode: "observed" }),
      );
    });
  });

  it("shows a reader with no deny list only the lines that apply", () => {
    // The deny paragraph is rendered only when there is something to deny.
    renderSection(
      {
        mode: "enforced",
        sessionLimit: { micros: "5000000", currency: "USD" },
        sessionLimitUsd: 5,
        modelAllow: ["gpt-5"],
        modelDeny: [],
      },
      false,
    );
    expect(screen.getByText(/gpt-5/)).toBeTruthy();
    expect(screen.queryByText(/Denied models/)).toBeNull();
  });

  it("shows a reader the policy and no form", () => {
    renderSection(
      {
        mode: "enforced",
        sessionLimit: { micros: "25000000", currency: "USD" },
        sessionLimitUsd: 25,
        modelAllow: ["claude-opus-*"],
        modelDeny: ["gpt-4o"],
      },
      false,
    );
    expect(
      screen.queryByRole("button", { name: /save the policy/i }),
    ).toBeNull();
    expect(screen.getByTestId("money").textContent).toContain("25.00");
    expect(screen.getByText(/claude-opus-\*/)).toBeTruthy();
  });

  it("tells a reader with no allowlist that every model is permitted", () => {
    // The negative control for the line above. "No models listed" has to
    // read as "every model", never as "none".
    renderSection(
      {
        ...OBSERVED,
        sessionLimit: { micros: "5000000", currency: "USD" },
        sessionLimitUsd: 5,
      },
      false,
    );
    expect(screen.getByText(spend.spend.gateway.noAllowlist)).toBeTruthy();
  });
});
