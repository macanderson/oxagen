// @vitest-environment jsdom
// The request-a-mandate dialog: it collects the grant a person asks for,
// sends it to the action for this agent and workspace, returns to the agent's
// mandates on success, and names a refusal in the dialog without navigating.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  await user.click(within(form).getByLabelText("moves_money"));
  await user.type(within(form).getByLabelText("Measure"), "rows");
  await user.type(within(form).getByLabelText("Unit"), "rows");
  await user.type(within(form).getByLabelText("Per period"), "2000");
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
    // A mandate covers a tool only when it names every tag that tool declares,
    // so the control has to be able to express a set, not a choice.
    const chosen = within(dialog()).getAllByRole("checkbox");
    expect(chosen.map((box) => box.getAttribute("value"))).toEqual([
      "moves_money",
      "destroys_data",
      "alters_production",
      "communicates_externally",
      "changes_access",
      "changes_entitlement",
    ]);
    for (const box of chosen) expect(box).not.toBeChecked();
    expect(dialog()).toHaveTextContent("Name every consequence");
    // The six are a starter set; a workspace defines its own, and a tool
    // declaring one of those must still be nameable here.
    expect(dialog()).toHaveTextContent("the starter set");
    expect(
      within(dialog()).getByLabelText(/Others the tools declare/),
    ).toHaveValue("");
    expect(dialog()).toHaveTextContent("There is no unbounded option.");
    expect(dialog()).toHaveTextContent("It cannot be “calls”");
    expect(dialog()).toHaveTextContent("never scaled");
    expect(dialog()).toHaveTextContent("Not a currency code");
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
      consequenceTags: "moves_money",
      measure: "rows",
      unit: "rows",
      perCall: "",
      perPeriod: "2000",
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

  // The form cannot read the tool version's declaration and so cannot know
  // whether a limit should be scaled to micros. It therefore offers no control
  // that would decide that, defaults no field to a currency, and asks for
  // whole units — the one shape it can write without possibly writing a bound
  // wider than the one typed.
  it("offers nothing that would scale a limit, and defaults no unit", async () => {
    draw();
    await open();
    const form = dialog();
    expect(within(form).queryByLabelText("What it counts")).toBeNull();
    expect(within(form).queryByLabelText("Currency or unit")).toBeNull();
    expect(within(form).getByLabelText("Unit")).toHaveValue("");
    expect(within(form).getByLabelText("Measure")).toHaveValue("");
    for (const label of ["Per call", "Per period"]) {
      expect(within(form).getByLabelText(label)).toHaveAttribute(
        "inputmode",
        "numeric",
      );
    }
  });

  // Every cap on this form is derived from a contract rule, because a cap
  // chosen by hand is the one that drifts — and a truncated consequence set is
  // still syntactically valid, so it would be requested, granted, and cover
  // nothing.
  it("caps each field where its contract rule does", async () => {
    draw();
    await open();
    const form = dialog();
    const cap = (label: RegExp | string) =>
      within(form).getByLabelText(label).getAttribute("maxlength");
    expect(cap("Measure")).toBe("64"); // measureNameSchema
    expect(cap("Unit")).toBe("32"); // currencyOrUnit.max(32)
    expect(cap("Purpose")).toBe("2000"); // purpose.max(2000)
    // 16 tags at 64 characters, comma-and-space separated.
    expect(cap(/Others the tools declare/)).toBe("1054");
  });

  it("sends a workspace tag typed beside the boxes", async () => {
    requestMandate.mockResolvedValue({
      ok: true,
      value: { mandateId: "mnd_4f2a9c", status: "draft" },
    });
    draw();
    const user = await open();
    await user.type(
      within(dialog()).getByLabelText(/Others the tools declare/),
      "ships_code",
    );
    await ask(user);
    expect(requestMandate).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({ consequenceTags: "moves_money,ships_code" }),
    );
  });

  // A tool that carries a consequence and declares no numeric measure can only
  // be limited on calls, so the measure fields cannot be required.
  it("lets a calls-only mandate through with the measure fields blank", async () => {
    draw();
    await open();
    const form = dialog();
    for (const label of ["Measure", "Unit"]) {
      expect(within(form).getByLabelText(label)).not.toBeRequired();
    }
    expect(within(form).getByLabelText("Calls per day")).toBeInTheDocument();
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

describe("RequestMandate while the dialog is open", () => {
  it("sends one request however often the form is submitted while it is pending (negative)", async () => {
    requestMandate.mockReturnValue(new Promise(() => undefined));
    draw();
    await open();
    const form = dialog().querySelector("form");
    if (form === null) throw new Error("request form not drawn");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(requestMandate).toHaveBeenCalledTimes(1);
  });

  it("forgets a refused request when the dialog is closed and opened again", async () => {
    requestMandate.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    draw();
    const user = await open();
    const form = dialog().querySelector("form");
    if (form === null) throw new Error("request form not drawn");
    fireEvent.submit(form);
    await screen.findByTestId("request-mandate-failure");
    await user.click(
      within(dialog()).getByRole("button", { name: /^(Close|Cancel)$/ }),
    );
    await open();
    expect(screen.queryByTestId("request-mandate-failure")).toBeNull();
    await expectNoAxe(document.body);
  });
});
