// @vitest-environment jsdom
// The request-a-mandate dialog: it collects the grant a person asks for,
// sends it to the action for this agent and workspace, returns to the agent's
// mandates on success, and names a refusal in the dialog without navigating.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, requestMandate } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  requestMandate: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ requestMandate }));

const { RequestMandate } = await import("./mandate-request");

function draw() {
  render(
    <IntlProvider>
      <RequestMandate
        org="acme"
        ws="core-platform"
        agentId="agt_invoicebot"
        agentSlug="invoice-bot"
      />
    </IntlProvider>,
  );
}

const dialog = () => screen.getByTestId("request-mandate");

async function open() {
  // `delay: null` keeps every interaction synchronous. The default wraps each
  // one in a timer, and this dialog has eleven fields: under the whole
  // package's coverage run the typing alone passed the 5 s case timeout.
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name: "Request a mandate" }));
  return user;
}

/** Fills the fields the contract requires and submits. */
async function ask(user: ReturnType<typeof userEvent.setup>) {
  const form = dialog();
  await user.type(within(form).getByLabelText("Per period"), "2000.00");
  await user.type(
    within(form).getByLabelText("Tools"),
    "stripe__create_payment@*",
  );
  await user.type(within(form).getByLabelText("Purpose"), "PO-4471");
  await user.type(within(form).getByLabelText("Valid from"), "2026-09-01");
  await user.type(within(form).getByLabelText("Valid to"), "2026-12-31");
  await user.click(
    within(form).getByRole("button", { name: "Request the mandate" }),
  );
}

beforeEach(() => {
  router.replace.mockReset();
  requestMandate.mockReset();
});
afterEach(cleanup);

describe("RequestMandate", () => {
  it("says a draft grants nothing, and offers the starter consequences", async () => {
    draw();
    await open();
    expect(dialog()).toHaveTextContent("A draft grants nothing.");
    expect(
      within(dialog())
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(
      expect.arrayContaining([
        "moves_money",
        "destroys_data",
        "changes_access",
      ]),
    );
    expect(dialog()).toHaveTextContent("There is no unbounded option.");
    expect(dialog()).toHaveTextContent("It cannot be “calls”");
    expect(dialog()).toHaveTextContent("this cannot be guessed");
    await expectNoAxe(document.body);
  });

  it("sends what the person asked for and returns to this agent's mandates", async () => {
    requestMandate.mockResolvedValue({
      ok: true,
      value: { mandateId: "mnd_4f2a9c", status: "draft" },
    });
    draw();
    const user = await open();
    await ask(user);
    expect(requestMandate).toHaveBeenCalledWith("acme", "core-platform", {
      agentId: "agt_invoicebot",
      consequenceTag: "moves_money",
      measure: "amount",
      kind: "amount",
      currency: "USD",
      perCall: "",
      perPeriod: "2000.00",
      period: "monthly",
      callsPerDay: "",
      tools: "stripe__create_payment@*",
      purpose: "PO-4471",
      validFrom: "2026-09-01",
      validTo: "2026-12-31",
    });
    expect(router.replace).toHaveBeenCalledWith(
      routes.agent("acme", "core-platform", "invoice-bot", {
        tab: "mandates",
      }),
    );
  });

  it("asks what the measure counts, since the form cannot read the declaration", async () => {
    draw();
    await open();
    const kind = within(dialog()).getByLabelText("What it counts");
    expect(
      [...kind.querySelectorAll("option")].map((o) => o.getAttribute("value")),
    ).toEqual(["amount", "count"]);
    expect(kind).toHaveValue("amount");
  });

  it("names a refusal in the dialog and navigates nowhere (negative)", async () => {
    requestMandate.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "measure_not_declared",
    });
    draw();
    const user = await open();
    await ask(user);
    const failure = await within(dialog()).findByTestId(
      "request-mandate-failure",
    );
    expect(failure).toHaveTextContent(/declares no such measure/);
    expect(router.replace).not.toHaveBeenCalled();
    await expectNoAxe(document.body);
  });

  it("names a write that never answered (negative)", async () => {
    requestMandate.mockRejectedValue(new Error("network"));
    draw();
    const user = await open();
    await ask(user);
    expect(
      await within(dialog()).findByTestId("request-mandate-failure"),
    ).toHaveTextContent(/action_failed/);
    expect(router.replace).not.toHaveBeenCalled();
  });
});
