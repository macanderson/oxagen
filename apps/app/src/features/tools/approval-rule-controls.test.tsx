// @vitest-environment jsdom
// The three auto-approval writes as a person makes them: the rule editor
// (create and edit, both through `saveApprovalRule`), the On/Off toggle, and
// the delete dialog with its switch-off alternative. A completed write reloads
// the Auto-approvals tab; a refusal is named where the person acted and
// navigates nowhere. Every refusal code the three handlers throw has its own
// sentence. Each state gets an axe check.
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  saveApprovalRule,
  setApprovalRuleEnabled,
  deleteApprovalRule,
  chooseToolPatterns,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  saveApprovalRule: vi.fn(),
  setApprovalRuleEnabled: vi.fn(),
  deleteApprovalRule: vi.fn(),
  chooseToolPatterns: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  saveApprovalRule,
  setApprovalRuleEnabled,
  deleteApprovalRule,
}));
vi.mock("@/features/shell/client", () => ({ chooseToolPatterns }));

const { RuleDelete, RuleEditor, RuleToggle } = await import(
  "./approval-rule-controls"
);
const { useActionFailure } = await import("./action-failure");
const { approvalRuleSet } = await import("./tools.builders");

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}
const formOf = (node: HTMLElement) => element(node.closest("form"), "form");

const at = { org: "acme", ws: "core-platform" };
const TAB = "/acme/core-platform/tools/policy";

/** The fixture's rules by id: `small-refunds` is on with hours, `repeat-deploys` off with a standing window. */
function rule(id: string) {
  const found = approvalRuleSet().rules.find((r) => r.slug === id);
  if (found === undefined) throw new Error(`no rule ${id}`);
  return found;
}

/**
 * The rule as the editor received it, the fifth argument `saveApprovalRule`
 * compares with the set it reads: an edit of a rule someone else changed in
 * the meantime is refused rather than written from the stale dialog.
 */
function rendered(id: string) {
  const { slug, ...rest } = rule(id);
  return {
    id: slug,
    name: rest.name,
    tools: rest.tools,
    enabled: rest.enabled,
    maxMeasures: rest.maxMeasures,
    allowTargets: rest.allowTargets,
    standingWindowMs: rest.standingWindowMs,
    businessHours: rest.businessHours,
  };
}

const intl = ({ children }: { children: ReactNode }) => (
  <IntlProvider>{children}</IntlProvider>
);

function withIntl(node: ReactNode) {
  return render(<IntlProvider>{node}</IntlProvider>);
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/**
 * Adds each pattern to the Tools picker as a person does: type it, press
 * Enter. A pattern the registry offers is picked; any other is kept as typed.
 */
function tools(...patterns: string[]) {
  const input = screen.getByLabelText("Tools");
  for (const pattern of patterns) {
    fireEvent.change(input, { target: { value: pattern } });
    fireEvent.keyDown(input, { key: "Enter" });
  }
}

/** What the Tools picker's hidden input submits. */
function submittedTools(): string | undefined {
  return document.querySelector<HTMLInputElement>(
    'input[type="hidden"][name="tools"]',
  )?.value;
}

const REGISTRY = {
  ok: true,
  value: {
    options: [
      {
        value: "stripe__create_refund@*",
        label: "stripe__create_refund@*",
        detail: "Create refund",
      },
      {
        value: "stripe__create_refund@2",
        label: "stripe__create_refund@2",
        detail: "Create refund",
      },
    ],
    partial: false,
  },
};

async function openEditor(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
  return screen.findByTestId("rule-editor");
}

beforeEach(() => {
  for (const fn of [
    router.replace,
    router.refresh,
    saveApprovalRule,
    setApprovalRuleEnabled,
    deleteApprovalRule,
  ]) {
    fn.mockReset();
  }
  chooseToolPatterns.mockReset().mockResolvedValue(REGISTRY);
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("RuleEditor › create", () => {
  it("writes the rule the person described and reloads the tab", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: true,
      value: { ruleId: "night-deploys" },
    });
    withIntl(<RuleEditor at={at} existing={null} />);
    const dialog = await openEditor("rule-create-open");
    expect(
      within(dialog).getByText("Create an auto-approval rule"),
    ).toBeVisible();

    fill("Rule id", "night-deploys");
    fill("Name", "Deploys to staging at night");
    tools("deploy__release", "  staging__* ");
    // One pattern per line, as the textarea this picker replaced sent them.
    expect(submittedTools()).toBe("deploy__release\nstaging__*");
    fill("Ceilings", "amount = 5000000");
    fill("Allow lists", "environment = staging, dev");
    fill("Standing approval window, in minutes", "30");
    fireEvent.click(screen.getByLabelText("Only during business hours"));
    fill("Time zone", "Europe/London");
    // The hours default to Monday to Friday; add Saturday.
    fireEvent.click(screen.getByLabelText("Sat"));
    fireEvent.submit(formOf(within(dialog).getByText("Create rule")));

    await waitFor(() => {
      expect(saveApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "create",
        {
          id: "night-deploys",
          name: "Deploys to staging at night",
          tools: ["deploy__release", "staging__*"],
          enabled: true,
          maxMeasures: { amount: "5000000" },
          allowTargets: { environment: ["staging", "dev"] },
          standingWindowMs: 1_800_000,
          businessHours: {
            timezone: "Europe/London",
            days: [1, 2, 3, 4, 5, 6],
            start: "09:00",
            end: "17:00",
          },
        },
        null,
      );
    });
    expect(router.replace).toHaveBeenCalledWith(TAB);
  });

  it("sends no ceilings, no allow lists, no window and no hours when the person names none", async () => {
    saveApprovalRule.mockResolvedValue({ ok: true, value: { ruleId: "bare" } });
    withIntl(<RuleEditor at={at} existing={null} />);
    const dialog = await openEditor("rule-create-open");
    fill("Rule id", "bare");
    fill("Name", "Bare rule");
    tools("deploy__release");
    fireEvent.click(screen.getByLabelText("On once saved"));
    fireEvent.submit(formOf(within(dialog).getByText("Create rule")));
    await waitFor(() => {
      expect(saveApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "create",
        {
          id: "bare",
          name: "Bare rule",
          tools: ["deploy__release"],
          enabled: false,
          maxMeasures: {},
          allowTargets: {},
          standingWindowMs: null,
          businessHours: null,
        },
        null,
      );
    });
  });

  // A glob is one value that may hold a space, so the allow list splits on
  // commas alone. Splitting on whitespace would leave `vendor:*` behind, which
  // admits every vendor target the author did not write.
  it("keeps an allow-list glob that contains a space whole", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: true,
      value: { ruleId: "vendor-payouts" },
    });
    withIntl(<RuleEditor at={at} existing={null} />);
    const dialog = await openEditor("rule-create-open");
    fill("Rule id", "vendor-payouts");
    fill("Name", "Vendor payouts");
    tools("stripe__create_payment");
    fill("Allow lists", "counterparty = vendor:* prod, cus_*");
    fireEvent.submit(formOf(within(dialog).getByText("Create rule")));
    await waitFor(() => {
      expect(saveApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "create",
        expect.objectContaining({
          allowTargets: { counterparty: ["vendor:* prod", "cus_*"] },
        }),
        null,
      );
    });
  });

  // A dropped line would save a rule without a ceiling the person wrote,
  // which releases more calls than they meant. The draft is refused whole.
  it.each([
    [
      "Ceilings",
      "amount 500",
      "Each ceiling line needs a measure, an equals sign, and a value",
    ],
    [
      "Allow lists",
      "environment =",
      "Each allow-list line needs a measure, an equals sign, and at least one pattern",
    ],
  ])(
    "refuses a %s line it cannot read and writes nothing",
    async (label, line, sentence) => {
      withIntl(<RuleEditor at={at} existing={null} />);
      const dialog = await openEditor("rule-create-open");
      fill("Rule id", "night-deploys");
      fill("Name", "Night deploys");
      tools("deploy__release");
      fill(label, line);
      fireEvent.submit(formOf(within(dialog).getByText("Create rule")));
      expect(
        await screen.findByTestId("rule-editor-failure"),
      ).toHaveTextContent(sentence);
      expect(saveApprovalRule).not.toHaveBeenCalled();
    },
  );

  it("picks a tool from the registry by typing part of its name, and keeps a typed pattern", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: true,
      value: { ruleId: "refunds" },
    });
    withIntl(<RuleEditor at={at} existing={null} />);
    const dialog = await openEditor("rule-create-open");
    fill("Rule id", "refunds");
    fill("Name", "Refunds");
    const input = screen.getByLabelText("Tools");
    fireEvent.change(input, { target: { value: "refund" } });
    // The registry is read when the picker first opens, and not before.
    expect(chooseToolPatterns).toHaveBeenCalledWith("acme", "core-platform");
    expect(
      await within(dialog).findByRole("option", {
        name: /stripe__create_refund@2/,
      }),
    ).toBeVisible();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    // A comma ends a typed entry, so a pattern the registry lacks is kept.
    fireEvent.change(input, { target: { value: "linear__*," } });
    expect(submittedTools()).toBe("stripe__create_refund@2\nlinear__*");
    fireEvent.submit(formOf(within(dialog).getByText("Create rule")));
    await waitFor(() => {
      expect(saveApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "create",
        expect.objectContaining({
          tools: ["stripe__create_refund@2", "linear__*"],
        }),
        null,
      );
    });
  });

  it("names a taken id where the person acted and navigates nowhere", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "rule_id_taken",
    });
    withIntl(<RuleEditor at={at} existing={null} />);
    const dialog = await openEditor("rule-create-open");
    fill("Rule id", "small-refunds");
    fill("Name", "Refunds");
    tools("stripe__create_refund@*");
    fireEvent.submit(formOf(within(dialog).getByText("Create rule")));
    expect(await screen.findByTestId("rule-editor-failure")).toHaveTextContent(
      "A rule with that id already exists.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a write that threw before it answered", async () => {
    saveApprovalRule.mockRejectedValue(new Error("network"));
    withIntl(<RuleEditor at={at} existing={null} />);
    const dialog = await openEditor("rule-create-open");
    fill("Rule id", "night-deploys");
    fill("Name", "Night deploys");
    tools("deploy__release");
    fireEvent.submit(formOf(within(dialog).getByText("Create rule")));
    expect(await screen.findByTestId("rule-editor-failure")).toHaveTextContent(
      "action_failed",
    );
  });

  it("says it is saving while the write is in flight", async () => {
    saveApprovalRule.mockReturnValue(new Promise(() => {}));
    withIntl(<RuleEditor at={at} existing={null} />);
    const dialog = await openEditor("rule-create-open");
    fill("Rule id", "night-deploys");
    fill("Name", "Night deploys");
    tools("deploy__release");
    fireEvent.submit(formOf(within(dialog).getByText("Create rule")));
    expect(await within(dialog).findByText("Saving")).toBeVisible();
  });
});

describe("RuleEditor › edit", () => {
  it("keeps the rule that opened the editor as the conflict baseline", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: true,
      value: { ruleId: "small-refunds" },
    });
    const original = rule("small-refunds");
    const view = withIntl(<RuleEditor at={at} existing={original} />);
    const dialog = await openEditor("rule-edit-small-refunds");

    // A streamed refresh can replace the prop while the uncontrolled fields
    // still contain the values that opened the dialog. The conflict token must
    // describe those visible fields, not the newer prop received afterward.
    view.rerender(
      <IntlProvider>
        <RuleEditor at={at} existing={{ ...original, enabled: false }} />
      </IntlProvider>,
    );
    fireEvent.submit(formOf(within(dialog).getByText("Save rule")));

    await waitFor(() => {
      expect(saveApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "edit",
        expect.objectContaining({ enabled: true }),
        rendered("small-refunds"),
      );
    });
  });

  it("opens on the rule as it is written and writes it back unchanged when nothing was edited", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: true,
      value: { ruleId: "small-refunds" },
    });
    withIntl(<RuleEditor at={at} existing={rule("small-refunds")} />);
    const dialog = await openEditor("rule-edit-small-refunds");
    expect(within(dialog).getByText("Edit this rule")).toBeVisible();
    // The id is the audit citation, so the edit shows it and offers no field.
    expect(screen.queryByLabelText("Rule id")).not.toBeInTheDocument();
    expect(within(dialog).getByText("small-refunds")).toBeVisible();
    expect(screen.getByLabelText("Ceilings")).toHaveValue("amount = 50000000");
    expect(screen.getByLabelText("Allow lists")).toHaveValue(
      "counterparty = cus_*, vendor:aws",
    );
    expect(screen.getByLabelText("Only during business hours")).toBeChecked();
    expect(screen.getByLabelText("Sat")).not.toBeChecked();

    fireEvent.submit(formOf(within(dialog).getByText("Save rule")));
    await waitFor(() => {
      expect(saveApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "edit",
        {
          id: "small-refunds",
          name: "Small refunds to known customers",
          tools: ["stripe__create_refund@*"],
          enabled: true,
          maxMeasures: { amount: "50000000" },
          allowTargets: { counterparty: ["cus_*", "vendor:aws"] },
          standingWindowMs: null,
          businessHours: {
            timezone: "Europe/London",
            days: [1, 2, 3, 4, 5],
            start: "09:00",
            end: "17:00",
          },
        },
        rendered("small-refunds"),
      );
    });
    expect(router.replace).toHaveBeenCalledWith(TAB);
  });

  it("carries a standing window in minutes and drops the hours when the person turns them off", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: true,
      value: { ruleId: "repeat-deploys" },
    });
    withIntl(<RuleEditor at={at} existing={rule("repeat-deploys")} />);
    const dialog = await openEditor("rule-edit-repeat-deploys");
    expect(
      screen.getByLabelText("Standing approval window, in minutes"),
    ).toHaveValue(60);
    expect(
      screen.getByLabelText("Only during business hours"),
    ).not.toBeChecked();
    fill("Standing approval window, in minutes", "90");
    fireEvent.submit(formOf(within(dialog).getByText("Save rule")));
    await waitFor(() => {
      expect(saveApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "edit",
        expect.objectContaining({
          id: "repeat-deploys",
          enabled: false,
          standingWindowMs: 5_400_000,
          businessHours: null,
        }),
        rendered("repeat-deploys"),
      );
    });
  });

  // Saving also asks for the role accountable for every consequence the
  // rule's tools carry, so an Admin can be refused. The Owner-or-Admin
  // sentence would name a role they already hold.
  it("names the consequence role, not the admin role, when the save is refused on it", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    withIntl(<RuleEditor at={at} existing={rule("small-refunds")} />);
    const dialog = await openEditor("rule-edit-small-refunds");
    fireEvent.submit(formOf(within(dialog).getByText("Save rule")));
    expect(await screen.findByTestId("rule-editor-failure")).toHaveTextContent(
      "holds the role accountable for every consequence its tools carry",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  // A tool pattern and a glob are each free text of up to 256 characters, so
  // one may contain the delimiter its field splits on. Saving any field of such
  // a rule would write the pattern back split, and `vendor:*` admits every
  // vendor target the author never wrote. The dialog shows the rule and offers
  // no Save (negative).
  it.each([
    [
      "an allow-list glob that contains a comma",
      { allowTargets: { counterparty: ["vendor:*,prod"] } },
    ],
    [
      "a tool pattern that contains a line break",
      { tools: ["stripe__create_refund@*\nstripe__create_payment@*"] },
    ],
  ])("shows a rule with %s but does not save it", async (_, change) => {
    withIntl(
      <RuleEditor at={at} existing={{ ...rule("small-refunds"), ...change }} />,
    );
    const dialog = await openEditor("rule-edit-small-refunds");
    expect(dialog).toHaveTextContent("cannot be saved here");
    expect(
      within(dialog).queryByRole("button", { name: "Save rule" }),
    ).toBeNull();
    fireEvent.submit(formOf(screen.getByLabelText("Name")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveApprovalRule).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("says the rule is gone when another person deleted it first", async () => {
    saveApprovalRule.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "approval_rule_not_found",
    });
    withIntl(<RuleEditor at={at} existing={rule("repeat-deploys")} />);
    const dialog = await openEditor("rule-edit-repeat-deploys");
    fireEvent.submit(formOf(within(dialog).getByText("Save rule")));
    expect(await screen.findByTestId("rule-editor-failure")).toHaveTextContent(
      "That rule is no longer in this workspace’s rule set.",
    );
  });
});

describe("RuleToggle", () => {
  it("switches an on rule off and reloads the tab", async () => {
    setApprovalRuleEnabled.mockResolvedValue({
      ok: true,
      value: { ruleId: "small-refunds", enabled: false },
    });
    withIntl(<RuleToggle at={at} rule={rule("small-refunds")} />);
    const button = screen.getByTestId("rule-toggle-small-refunds");
    expect(button).toHaveTextContent("Switch off");
    fireEvent.click(button);
    await waitFor(() => {
      expect(setApprovalRuleEnabled).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "small-refunds",
        false,
      );
    });
    expect(router.replace).toHaveBeenCalledWith(TAB);
  });

  // Switching on re-runs the checks the rule was saved under, so it can be
  // refused even for a person who may write rules.
  it("names a refusal to switch a rule on beside the button", async () => {
    setApprovalRuleEnabled.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "no_tool_matches",
    });
    withIntl(<RuleToggle at={at} rule={rule("repeat-deploys")} />);
    const button = screen.getByTestId("rule-toggle-repeat-deploys");
    expect(button).toHaveTextContent("Switch on");
    fireEvent.click(button);
    expect(
      await screen.findByTestId("rule-toggle-failure-repeat-deploys"),
    ).toHaveTextContent("A tool pattern matches no declared tool");
    expect(setApprovalRuleEnabled).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "repeat-deploys",
      true,
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names the Owner-or-Admin pair when switching off is refused on role", async () => {
    setApprovalRuleEnabled.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    withIntl(<RuleToggle at={at} rule={rule("small-refunds")} />);
    fireEvent.click(screen.getByTestId("rule-toggle-small-refunds"));
    expect(
      await screen.findByTestId("rule-toggle-failure-small-refunds"),
    ).toHaveTextContent("This needs an organization Owner or Admin.");
  });

  it("names the consequence role when switching on is refused on role", async () => {
    setApprovalRuleEnabled.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    withIntl(<RuleToggle at={at} rule={rule("repeat-deploys")} />);
    fireEvent.click(screen.getByTestId("rule-toggle-repeat-deploys"));
    expect(
      await screen.findByTestId("rule-toggle-failure-repeat-deploys"),
    ).toHaveTextContent("the role accountable for every consequence");
  });

  it("is busy while the write is in flight", async () => {
    setApprovalRuleEnabled.mockReturnValue(new Promise(() => {}));
    withIntl(<RuleToggle at={at} rule={rule("small-refunds")} />);
    const button = screen.getByTestId("rule-toggle-small-refunds");
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});

describe("RuleDelete", () => {
  it("names the rule, offers to switch it off instead, and deletes it on confirm", async () => {
    deleteApprovalRule.mockResolvedValue({
      ok: true,
      value: { ruleId: "small-refunds" },
    });
    withIntl(<RuleDelete at={at} rule={rule("small-refunds")} />);
    fireEvent.click(screen.getByTestId("rule-delete-small-refunds"));
    const dialog = await screen.findByTestId("rule-delete-dialog");
    expect(
      within(dialog).getByText(/Small refunds to known customers/),
    ).toBeVisible();
    expect(within(dialog).getByText(/policy:small-refunds/)).toBeVisible();
    expect(within(dialog).getByTestId("rule-delete-switch-off")).toBeVisible();
    fireEvent.submit(formOf(within(dialog).getByText("Delete rule")));
    await waitFor(() => {
      expect(deleteApprovalRule).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "small-refunds",
      );
    });
    expect(setApprovalRuleEnabled).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith(TAB);
  });

  it("switches the rule off instead when the person picks that, and deletes nothing", async () => {
    setApprovalRuleEnabled.mockResolvedValue({
      ok: true,
      value: { ruleId: "small-refunds", enabled: false },
    });
    withIntl(<RuleDelete at={at} rule={rule("small-refunds")} />);
    fireEvent.click(screen.getByTestId("rule-delete-small-refunds"));
    const dialog = await screen.findByTestId("rule-delete-dialog");
    fireEvent.click(within(dialog).getByTestId("rule-delete-switch-off"));
    await waitFor(() => {
      expect(setApprovalRuleEnabled).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "small-refunds",
        false,
      );
    });
    expect(deleteApprovalRule).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith(TAB);
  });

  it("offers no switch-off for a rule that is already off", async () => {
    withIntl(<RuleDelete at={at} rule={rule("repeat-deploys")} />);
    fireEvent.click(screen.getByTestId("rule-delete-repeat-deploys"));
    const dialog = await screen.findByTestId("rule-delete-dialog");
    expect(
      within(dialog).queryByTestId("rule-delete-switch-off"),
    ).not.toBeInTheDocument();
  });

  // Deleting runs no consequence check, so a role refusal names the
  // Owner-or-Admin pair rather than the consequence role.
  it("names a refusal in the dialog and navigates nowhere", async () => {
    deleteApprovalRule.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    withIntl(<RuleDelete at={at} rule={rule("repeat-deploys")} />);
    fireEvent.click(screen.getByTestId("rule-delete-repeat-deploys"));
    const dialog = await screen.findByTestId("rule-delete-dialog");
    fireEvent.submit(formOf(within(dialog).getByText("Delete rule")));
    expect(await screen.findByTestId("rule-delete-failure")).toHaveTextContent(
      "This needs an organization Owner or Admin.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("useActionFailure › rules", () => {
  it.each([
    ["org_role_required", "the role accountable for every consequence"],
    ["no_role_covers_all_tags", "Split the rule by tool."],
    ["rule_id_taken", "A rule with that id already exists."],
    ["approval_rule_not_found", "no longer in this workspace’s rule set"],
    ["no_tool_matches", "matches no declared tool"],
    ["rule_not_gated", "would never be enforced"],
    ["measure_not_declared", "a matched tool does not declare"],
    ["measure_wrong_type", "a measure of the wrong kind"],
    ["too_many_consequences", "more than 64 distinct consequences"],
  ] as const)("names %s", (code, expected) => {
    const hook = renderHook(() => useActionFailure("rules"), {
      wrapper: intl,
    });
    expect(
      hook.result.current({ ok: false, reason: "conflict", code }),
    ).toContain(expected);
    hook.unmount();
  });

  it("keeps the Owner-or-Admin sentence for the other Tools writes", () => {
    const hook = renderHook(() => useActionFailure(), { wrapper: intl });
    expect(
      hook.result.current({
        ok: false,
        reason: "denied",
        code: "org_role_required",
      }),
    ).toContain("This needs an organization Owner or Admin.");
    hook.unmount();
  });
});
