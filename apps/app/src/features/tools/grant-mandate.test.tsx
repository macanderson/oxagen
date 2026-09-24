// @vitest-environment jsdom
// The grant dialog as a person uses it: it collects a whole mandate, sends it
// for this workspace with the agent picked, returns to the Mandates ledger on
// success, and names a refusal in the dialog without navigating. Opened on a
// requested row it fixes the agent, prefills what the draft recorded, sends the
// draft's id, and refuses a draft it cannot carry whole. Each state gets
// an axe check.
import {
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  callsAuthority,
  mandateAuthority,
  mandateRow,
} from "@/test/mandate-views";
import type { AgentChoices } from "./grant-mandate";

const { router, grantMandate } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  grantMandate: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./grant-actions", () => ({ grantMandate }));

const { GrantMandate } = await import("./grant-mandate");
const { useGrantFailure } = await import("./grant-failure");

const at = { org: "acme", ws: "core-platform" };
const MANDATES = routes.tools("acme", "core-platform", { tab: "policy" });

const AGENTS: AgentChoices = {
  ok: true,
  agents: [
    { id: "agt_invoicebot", slug: "invoice-bot", name: "Invoice bot" },
    { id: "agt_releasebot", slug: "release-bot", name: "Release bot" },
  ],
  partial: false,
};

function draw(
  props: {
    agents?: AgentChoices;
    request?: ReturnType<typeof mandateRow>;
  } = {},
) {
  render(
    <IntlProvider>
      <GrantMandate
        at={at}
        agents={props.agents ?? AGENTS}
        request={props.request ?? null}
      />
    </IntlProvider>,
  );
}

async function open(name: string | RegExp = "Grant a mandate") {
  // `delay: null` keeps each interaction synchronous; this dialog has many
  // fields and the default per-keystroke timer is slow under coverage.
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name }));
  return user;
}

const dialog = () => screen.getByTestId("grant-mandate");

/** Fills the fields a grant needs and submits. */
async function grant(user: ReturnType<typeof userEvent.setup>) {
  const form = dialog();
  await user.selectOptions(
    within(form).getByLabelText("Agent"),
    "agt_releasebot",
  );
  await user.click(within(form).getByLabelText("moves_money"));
  await user.type(
    within(form).getByLabelText("Tools"),
    "stripe__create_payment@*",
  );
  await user.type(within(form).getByLabelText("Measure"), "rows");
  await user.type(within(form).getByLabelText("Unit"), "rows");
  await user.type(within(form).getByLabelText("Per period"), "2000");
  await user.type(
    within(form).getByLabelText("Allowed targets, separated by commas"),
    "vendor:aws",
  );
  await user.type(
    within(form).getByLabelText("Measure the target is read from"),
    "recipient",
  );
  await user.type(
    within(form).getByLabelText("Who may answer"),
    "role:Billing",
  );
  await user.type(within(form).getByLabelText("Purpose"), "PO-4471");
  await user.type(within(form).getByLabelText("Valid from"), "2026-09-01");
  await user.type(within(form).getByLabelText("Valid to"), "2026-12-31");
  await user.click(
    within(form).getByRole("button", { name: "Grant the mandate" }),
  );
}

beforeEach(() => {
  router.replace.mockReset();
  grantMandate.mockReset();
});
afterEach(cleanup);

describe("GrantMandate", () => {
  it("opens blank, offers the workspace's agents and every section", async () => {
    draw();
    await open();
    const form = dialog();
    const agent = within(form).getByLabelText("Agent");
    expect(
      within(agent)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Invoice bot (invoice-bot)", "Release bot (release-bot)"]);
    for (const box of within(form).getAllByRole("checkbox"))
      expect(box).not.toBeChecked();
    expect(within(form).getByLabelText("Measure")).toHaveValue("");
    expect(within(form).getByText("Counterparties")).toBeInTheDocument();
    expect(within(form).getByText("Approval")).toBeInTheDocument();
    expect(form).toHaveTextContent("There is no unbounded option.");
    expect(form).toHaveTextContent("Not a currency code");
    await expectNoAxe(document.body);
  });

  it("sends the grant for the agent picked and returns to the ledger", async () => {
    grantMandate.mockResolvedValue({
      ok: true,
      value: { mandateId: "mnd_4f2a9c", status: "active" },
    });
    draw();
    const user = await open();
    await grant(user);
    expect(grantMandate).toHaveBeenCalledWith("acme", "core-platform", {
      agentId: "agt_releasebot",
      requestId: null,
      consequenceTags: "moves_money",
      measure: "rows",
      unit: "rows",
      perCall: "",
      perPeriod: "2000",
      period: "monthly",
      callsPerDay: "",
      tools: "stripe__create_payment@*",
      targetMeasure: "recipient",
      targetAllow: "vendor:aws",
      targetDeny: "",
      alwaysHumanFor: "",
      humanAboveMeasure: "",
      humanAboveValue: "",
      approvers: "role:Billing",
      purpose: "PO-4471",
      validFrom: "2026-09-01",
      validTo: "2026-12-31",
    });
    expect(router.replace).toHaveBeenCalledWith(MANDATES);
  });

  it("names a refusal in the dialog and navigates nowhere (negative)", async () => {
    grantMandate.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    draw();
    const user = await open();
    await grant(user);
    const failure = await within(dialog()).findByTestId(
      "grant-mandate-failure",
    );
    expect(failure).toHaveTextContent(
      "Your org role is not accountable for every consequence this mandate names.",
    );
    expect(router.replace).not.toHaveBeenCalled();
    await expectNoAxe(document.body);
  });

  it("names the field the action refused (negative)", async () => {
    grantMandate.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "approvers",
    });
    draw();
    const user = await open();
    await grant(user);
    expect(
      await within(dialog()).findByTestId("grant-mandate-failure"),
    ).toHaveTextContent("Check the field “Who may answer”.");
  });

  it("names a write that never answered (negative)", async () => {
    grantMandate.mockRejectedValue(new Error("network"));
    draw();
    const user = await open();
    await grant(user);
    expect(
      await within(dialog()).findByTestId("grant-mandate-failure"),
    ).toHaveTextContent(/action_failed/);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("says when the agents could not be read, and offers no submit (negative)", async () => {
    draw({ agents: { ok: false } });
    await open();
    expect(dialog()).toHaveTextContent("could not be read");
    expect(within(dialog()).queryByLabelText("Agent")).toBeNull();
    expect(
      within(dialog()).queryByRole("button", { name: "Grant the mandate" }),
    ).toBeNull();
    await expectNoAxe(document.body);
  });

  it("says when the workspace has no agent to grant to", async () => {
    draw({ agents: { ok: true, agents: [], partial: false } });
    await open();
    expect(dialog()).toHaveTextContent("no agent that can hold a mandate");
    expect(
      within(dialog()).queryByRole("button", { name: "Grant the mandate" }),
    ).toBeNull();
  });

  it("says when the picker holds only the first page of agents", async () => {
    draw({ agents: { ...AGENTS, partial: true } });
    await open();
    expect(dialog()).toHaveTextContent(
      "The first page of this workspace's agents.",
    );
  });
});

describe("GrantMandate on a requested draft", () => {
  const request = mandateRow({
    id: "mnd_7c1d2e",
    status: "draft",
    grantedBy: null,
    roleAtGrant: null,
    consequenceTags: ["moves_money", "ships_code"],
    tools: ["stripe__create_payment@*", "deploy__ship@3"],
    authority: [
      mandateAuthority({
        measure: "rows",
        perCall: { kind: "count", count: "50", unit: "rows" },
        perPeriod: { kind: "count", count: "1000", unit: "rows" },
        period: "weekly",
      }),
      callsAuthority(),
    ],
    approval: {
      humanAbove: [{ measure: "rows", value: null, recorded: "500" }],
      alwaysHumanFor: ["ships_code"],
      approvers: ["role:Billing"],
    },
  });

  const draftDialog = () => screen.getByTestId("grant-mandate-mnd_7c1d2e");

  it("fixes the agent and prefills what the draft recorded", async () => {
    draw({ request });
    await open("Grant mandate mnd_7c1d2e");
    const form = draftDialog();
    expect(within(form).queryByLabelText("Agent")).toBeNull();
    expect(form).toHaveTextContent("invoice-bot");
    expect(within(form).getByLabelText("moves_money")).toBeChecked();
    expect(within(form).getByLabelText("destroys_data")).not.toBeChecked();
    expect(within(form).getByLabelText(/Others the tools declare/)).toHaveValue(
      "ships_code",
    );
    expect(within(form).getByLabelText("Tools")).toHaveValue(
      "stripe__create_payment@*, deploy__ship@3",
    );
    expect(within(form).getByLabelText("Measure")).toHaveValue("rows");
    expect(within(form).getByLabelText("Unit")).toHaveValue("rows");
    expect(within(form).getByLabelText("Per call")).toHaveValue("50");
    expect(within(form).getByLabelText("Per period")).toHaveValue("1000");
    expect(within(form).getByLabelText("Period")).toHaveValue("weekly");
    expect(within(form).getByLabelText("Calls per day")).toHaveValue("50");
    expect(
      within(form).getByLabelText("Measure the target is read from"),
    ).toHaveValue("amount");
    expect(
      within(form).getByLabelText("Allowed targets, separated by commas"),
    ).toHaveValue("vendor:aws, vendor:github");
    expect(within(form).getByLabelText("Always ask a person for")).toHaveValue(
      "ships_code",
    );
    expect(within(form).getByLabelText("Threshold")).toHaveValue("500");
    expect(within(form).getByLabelText("Who may answer")).toHaveValue(
      "role:Billing",
    );
    expect(within(form).getByLabelText("Valid from")).toHaveValue("2026-09-01");
    expect(within(form).getByLabelText("Valid to")).toHaveValue("2026-12-31");
    expect(form).not.toHaveTextContent("more than this form can carry");
    await expectNoAxe(document.body);
  });

  it("sends the draft's agent and id with the reviewed body", async () => {
    grantMandate.mockResolvedValue({
      ok: true,
      value: { mandateId: "mnd_7c1d2e", status: "active" },
    });
    draw({ request });
    const user = await open("Grant mandate mnd_7c1d2e");
    await user.click(
      within(draftDialog()).getByRole("button", { name: "Grant this request" }),
    );
    expect(grantMandate).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({
        agentId: "agt_invoicebot",
        requestId: "mnd_7c1d2e",
        consequenceTags: "moves_money,ships_code",
        measure: "rows",
        perCall: "50",
        perPeriod: "1000",
        period: "weekly",
        callsPerDay: "50",
      }),
    );
    expect(router.replace).toHaveBeenCalledWith(MANDATES);
  });

  // grant_mandate replaces the draft's body with what the form sends, so a draft
  // the form cannot hold whole would be activated weaker than it was asked for.
  // The dialog shows it for review and offers no submit (negative).
  it.each([
    ["a money limit", mandateRow({ id: "mnd_7c1d2e", status: "draft" })],
    [
      "two count limits",
      mandateRow({
        ...request,
        authority: [
          mandateAuthority({
            measure: "rows",
            perCall: null,
            perPeriod: { kind: "count", count: "1000", unit: "rows" },
          }),
          mandateAuthority({
            measure: "files",
            perCall: null,
            perPeriod: { kind: "count", count: "20", unit: "files" },
          }),
        ],
      }),
    ],
    [
      "a calls limit that is not a daily total",
      mandateRow({
        ...request,
        authority: [
          mandateAuthority({
            measure: "rows",
            perCall: { kind: "count", count: "50", unit: "rows" },
            perPeriod: { kind: "count", count: "1000", unit: "rows" },
            period: "weekly",
          }),
          { ...callsAuthority(), period: "weekly" },
        ],
      }),
    ],
    [
      "two thresholds",
      mandateRow({
        ...request,
        approval: {
          ...request.approval,
          humanAbove: [
            { measure: "rows", value: null, recorded: "500" },
            { measure: "files", value: null, recorded: "5" },
          ],
        },
      }),
    ],
    [
      "two target rules",
      mandateRow({
        ...request,
        targets: [
          { measure: "recipient", allow: ["vendor:aws"], deny: [] },
          { measure: "account", allow: ["acct:1"], deny: [] },
        ],
      }),
    ],
    // A glob is free text, so `vendor:*,prod` is one legal glob. The field is
    // comma-separated, so it would come back as `vendor:*` and `prod`, and the
    // first admits every vendor target the requester never named.
    [
      "an allowed target that contains a comma",
      mandateRow({
        ...request,
        targets: [{ measure: "recipient", allow: ["vendor:*,prod"], deny: [] }],
      }),
    ],
    [
      "a denied target that contains a comma",
      mandateRow({
        ...request,
        targets: [
          { measure: "recipient", allow: ["vendor:aws"], deny: ["a,b"] },
        ],
      }),
    ],
    [
      "a tool pattern that contains a comma",
      mandateRow({ ...request, tools: ["stripe__create_payment@1,2"] }),
    ],
  ])(
    "refuses a draft with %s rather than granting part of it",
    async (_, draft) => {
      draw({ request: draft });
      await open("Grant mandate mnd_7c1d2e");
      const form = draftDialog();
      expect(form).toHaveTextContent("more than this form can carry");
      expect(
        within(form).queryByRole("button", { name: "Grant this request" }),
      ).toBeNull();
      await expectNoAxe(document.body);
    },
  );
});

describe("useGrantFailure", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <IntlProvider>{children}</IntlProvider>
  );
  /** The hook's sentence function, rendered inside the test that uses it. */
  const sentenceOf = () =>
    renderHook(() => useGrantFailure(), { wrapper }).result.current;

  it.each([
    ["denied", "org_role_required", "not accountable for every consequence"],
    ["denied", "no_role_covers_all_tags", "No single org role"],
    ["denied", "no_principal", "carries no person"],
    ["not_found", "agent_not_found", "agent is not recorded"],
    ["conflict", "agent_has_no_principal", "no identity a mandate can bind to"],
    ["not_found", "mandate_not_found", "request is not recorded"],
    ["conflict", "not_a_draft", "granted or declined by someone else first"],
    ["conflict", "no_tool_matches", "matches no declared tool"],
    ["conflict", "measure_not_declared", "declares no such measure"],
    ["conflict", "measure_unit_mismatch", "in another unit"],
    ["conflict", "measure_kind_conflict", "no single figure to enforce"],
    ["conflict", "agent_retired", "agent is retired"],
    ["conflict", "time_zone_unsupported", "not one this server can read"],
    ["denied", "something_new", "The grant was refused: something_new."],
  ] as const)("names %s %s", (reason, code, expected) => {
    expect(sentenceOf()({ ok: false, reason, code })).toContain(expected);
  });

  it("names the other outcomes", () => {
    const sentence = { current: sentenceOf() };
    expect(
      sentence.current({ ok: false, reason: "invalid", code: "invalid_input" }),
    ).toContain("not a value a grant accepts");
    expect(
      sentence.current({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_1",
      }),
    ).toContain("acr_1");
    expect(
      sentence.current({
        ok: false,
        reason: "unavailable",
        code: "time_zone_unavailable",
      }),
    ).toContain("Your time zone could not be read");
    expect(
      sentence.current({
        ok: false,
        reason: "exhausted",
        code: "gau_exhausted",
      }),
    ).toContain("gau_exhausted");
  });
});
