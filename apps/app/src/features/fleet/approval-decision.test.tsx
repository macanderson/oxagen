// @vitest-environment jsdom
// The decision dialog: what it sends, what it says when the kernel refuses,
// and what it does with an answer.
//
// Every state this surface has is a case here, because each one is a sentence
// an operator acts on. Pending is the two buttons with no default. Submitting
// names the decision in flight, so a slow write does not look like a dead
// button. Denied is the handler's own reason, since the gate is the handler's
// (INV-29) and "your roles do not cover this" is the only useful thing to say.
// An error keeps the kernel's code and says the call is untouched, because the
// question an operator has after a failed decision is whether it half
// happened. Resolved closes the dialog and re-reads the page, so the card
// leaves the pending panel and, on the Run page, joins the resolved list.
//
// The denial-with-no-reason case is here AND in actions.test.ts on purpose.
// The rule lives on the server, because a `required` attribute is a courtesy
// and not a gate; this case proves the dialog shows what the refusal said
// rather than swallowing it.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_NOTE_MAX,
  type ApprovalSettlement,
  type AutoEligibility,
} from "@/data/contracts/approvals";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, resolveApprovalAction, readApprovalEligibility } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    resolveApprovalAction: vi.fn(),
    readApprovalEligibility: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The exhausted refusal carries a link out of it (INV-14), and `next/link`
// wants a router this render does not mount.
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("./actions", () => ({
  resolveApprovalAction,
  readApprovalEligibility,
}));

const { ApprovalDecision } = await import("./approval-decision");

const APPROVAL = "apr_q8t1";

const eligibility: AutoEligibility = {
  ruleRef: "small-vendor-payments",
  ok: false,
  reasons: ["measure_above_ceiling:amount"],
  floor: false,
};

function draw(
  recorded: AutoEligibility | null = eligibility,
  mandateId: string | null = null,
) {
  render(
    <IntlProvider>
      <ApprovalDecision
        approvalId={APPROVAL}
        tool="stripe__create_payment"
        eligibility={recorded}
        mandateId={mandateId}
        org="acme"
        ws="core-platform"
        on="fleet"
      />
    </IntlProvider>,
  );
}

const dialog = () => screen.getByTestId("approval-decision");

async function open({ waitForRead = true } = {}) {
  // Avoid input timer delays. Wait for the async read separately.
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByTestId("decide"));
  await screen.findByTestId("approval-decision");
  if (waitForRead) {
    await waitFor(() => {
      expect(screen.queryByTestId("eligibility-checking")).toBeNull();
    });
  }
  return user;
}

async function decisionFailure() {
  return waitFor(() => {
    const failure = screen.getByTestId("approval-decision-failure");
    for (const decision of ["approve", "deny"]) {
      expect(within(dialog()).getByTestId(decision)).not.toHaveAttribute(
        "aria-disabled",
      );
    }
    return failure;
  });
}

beforeEach(() => {
  router.refresh.mockReset();
  resolveApprovalAction.mockReset();
  readApprovalEligibility.mockReset();
  readApprovalEligibility.mockResolvedValue({
    ok: true,
    value: { settlement: null, eligibility },
  });
  resolveApprovalAction.mockResolvedValue({
    ok: true,
    value: { approvalId: APPROVAL, resolution: "approved", mandate: null },
  });
});
afterEach(cleanup);

describe("the decision", () => {
  it("opens on the call, its recorded evaluation, and two buttons with no default", async () => {
    draw();
    await open();
    const form = dialog();
    expect(form).toHaveTextContent("Decide on stripe__create_payment");
    expect(within(form).getByTestId("eligibility")).toHaveTextContent(
      "Rule small-vendor-payments did not release this call.",
    );
    expect(within(form).getByTestId("approve")).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(within(form).getByTestId("deny")).not.toHaveAttribute(
      "aria-disabled",
    );
    await expectNoAxe(document.body);
  });

  it("approves with the reason typed, then re-reads the page rather than reloading it", async () => {
    draw();
    const user = await open();
    await user.type(
      within(dialog()).getByLabelText("Reason"),
      "vendor is on the approved list",
    );
    await user.click(within(dialog()).getByTestId("approve"));
    expect(resolveApprovalAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        approvalId: APPROVAL,
        decision: "approved",
        note: "vendor is on the approved list",
      },
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledOnce();
      expect(screen.queryByTestId("approval-decision")).toBeNull();
    });
  });

  it("denies with the reason, sending the decision the button names", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: true,
      value: { approvalId: APPROVAL, resolution: "denied", mandate: null },
    });
    draw();
    const user = await open();
    await user.type(
      within(dialog()).getByLabelText("Reason"),
      "vendor is not on the approved list",
    );
    await user.click(within(dialog()).getByTestId("deny"));
    expect(resolveApprovalAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        approvalId: APPROVAL,
        decision: "denied",
        note: "vendor is not on the approved list",
      },
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledOnce();
    });
  });

  it("says a denial needs a reason, and the call is untouched (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "note_required",
      field: "note",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("deny"));
    expect(await decisionFailure()).toHaveTextContent(
      "Write the reason this call is denied.",
    );
    // The dialog stays open on the reason the operator now has to write, and
    // nothing re-read, because nothing changed.
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names the office that answers when the handler refuses the roles (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent(
      "the office accountable for the mandate's consequences answers it",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("keeps the kernel's code and says the call is untouched when the write fails (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "approval_store_unreachable",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent(
      "The decision did not reach the kernel (approval_store_unreachable). The call is untouched, so it is safe to try again.",
    );
  });

  it("says nothing was billed when no pending row matched (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "approval_expired",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent("Nothing was billed.");
  });

  // ADR-115: the decision is the one billed action of this surface, and
  // INV-14 has the refusal carry the way out of it.
  it.each(["gau_exhausted", "billing_suspended", "budget_exceeded"] as const)(
    "names the exhausted credit the billing gate raised and links to billing: %s (negative)",
    async (code) => {
      resolveApprovalAction.mockResolvedValue({
        ok: false,
        reason: "exhausted",
        code,
      });
      draw();
      const user = await open();
      await user.click(within(dialog()).getByTestId("approve"));
      const alert = await decisionFailure();
      expect(alert).toHaveTextContent(`(${code})`);
      expect(
        within(alert).getByTestId("approval-decision-billing"),
      ).toHaveAttribute("href", "/acme/billing");
    },
  );

  it("carries no billing link on a refusal credit had nothing to do with (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(
      within(await decisionFailure()).queryByTestId(
        "approval-decision-billing",
      ),
    ).toBeNull();
  });

  it("names the decision in flight while the write is out", async () => {
    const decision = Promise.withResolvers<unknown>();
    resolveApprovalAction.mockReturnValue(decision.promise);
    draw();
    const user = await open();
    await user.type(within(dialog()).getByLabelText("Reason"), "no");
    await user.click(within(dialog()).getByTestId("deny"));
    const deny = within(dialog()).getByTestId("deny");
    expect(deny).toHaveTextContent("Denying");
    expect(deny).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      decision.resolve({
        ok: true,
        value: { approvalId: APPROVAL, resolution: "denied", mandate: null },
      });
      await decision.promise;
    });
  });
});

describe("the evaluation the dialog reads again", () => {
  it("holds both decisions until the freshness read settles", async () => {
    const read = Promise.withResolvers<unknown>();
    readApprovalEligibility.mockReturnValue(read.promise);
    draw();
    const user = await open({ waitForRead: false });
    for (const decision of ["approve", "deny"]) {
      expect(within(dialog()).getByTestId(decision)).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.click(within(dialog()).getByTestId(decision));
    }
    expect(resolveApprovalAction).not.toHaveBeenCalled();
    await act(async () => {
      read.resolve({ ok: true, value: { settlement: null, eligibility } });
      await read.promise;
    });
    expect(within(dialog()).getByTestId("approve")).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("reports a rejected transport and releases the decisions", async () => {
    readApprovalEligibility.mockRejectedValue(
      new Error("transport unavailable"),
    );
    draw();
    await open();
    await waitFor(() => {
      expect(screen.getByTestId("eligibility-unread")).toHaveTextContent(
        "action_failed",
      );
      expect(screen.queryByTestId("eligibility-checking")).toBeNull();
      expect(within(dialog()).getByTestId("approve")).not.toHaveAttribute(
        "aria-disabled",
      );
    });
  });

  it("discards a read that settles after its dialog closes", async () => {
    const first = Promise.withResolvers<unknown>();
    readApprovalEligibility.mockReturnValueOnce(first.promise);
    draw();
    const user = await open({ waitForRead: false });
    await user.keyboard("{Escape}");
    await act(async () => {
      first.resolve({
        ok: true,
        value: {
          settlement: {
            by: "person",
            resolution: "approved",
            id: "usr_stale",
            name: "Stale Reader",
          },
          eligibility,
        },
      });
      await first.promise;
    });
    const second = Promise.withResolvers<unknown>();
    readApprovalEligibility.mockReturnValueOnce(second.promise);
    await user.click(screen.getByTestId("decide"));
    expect(screen.queryByTestId("approval-settled")).toBeNull();
    expect(screen.getByTestId("eligibility-checking")).toBeInTheDocument();
    await act(async () => {
      second.resolve({ ok: true, value: { settlement: null, eligibility } });
      await second.promise;
    });
  });

  it("refuses to decide a call somebody else already answered, naming them", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: {
        settlement: {
          by: "person",
          resolution: "denied",
          id: "usr_marcusbell",
          name: "Marcus Bell",
        },
        eligibility,
      },
    });
    draw();
    await open();
    const settled = screen.getByTestId("approval-settled");
    // #3521: the person's name is the label, and the public id sits beside it
    // in its own copyable span rather than standing in for the name.
    expect(settled).toHaveTextContent(
      "Marcus Bell (usr_marcusbell) already answered this call: denied. Nothing here can change it.",
    );
    expect(
      within(settled).getByTestId("approval-settled-id"),
    ).toHaveTextContent(/^usr_marcusbell$/);
    expect(within(settled).getByTestId("approval-settled-id")).toHaveClass(
      "select-all",
    );
    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog()).getByTestId("approve"));
    await user.click(within(dialog()).getByTestId("deny"));
    expect(resolveApprovalAction).not.toHaveBeenCalled();
  });

  it("names a person with no display name by what they are, with the id beside it", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: {
        settlement: {
          by: "person",
          resolution: "approved",
          id: "usr_q8t1",
          name: null,
        },
        eligibility,
      },
    });
    draw();
    await open();
    expect(screen.getByTestId("approval-settled")).toHaveTextContent(
      "A person with no display name (usr_q8t1) already answered this call: approved.",
    );
  });

  it("names the rule that released a call with no person, by its id", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: {
        settlement: {
          by: "rule",
          resolution: "approved",
          rule: "small-vendor-payments",
        },
        eligibility,
      },
    });
    draw();
    await open();
    const settled = screen.getByTestId("approval-settled");
    expect(settled).toHaveTextContent(
      "Rule small-vendor-payments already resolved this call with no person: approved.",
    );
    expect(within(settled).queryByTestId("approval-settled-id")).toBeNull();
  });

  // #3521: a mandate revoke or expiry closes the call with no resolver. The
  // dialog used to read a null resolver as "still waiting" and left both
  // buttons live until the write came back approval_expired.
  it("holds both decisions on a call that expired with nobody resolving it", async () => {
    const expired: ApprovalSettlement = { by: "none", resolution: "expired" };
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { settlement: expired, eligibility },
    });
    draw();
    const user = await open();
    expect(screen.getByTestId("approval-settled")).toHaveTextContent(
      "This call expired before anyone answered it, or its mandate was revoked. Nothing here can change it.",
    );
    for (const decision of ["approve", "deny"]) {
      expect(within(dialog()).getByTestId(decision)).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.click(within(dialog()).getByTestId(decision));
    }
    expect(resolveApprovalAction).not.toHaveBeenCalled();
  });

  it("keeps the recorded line and names the code when the re-read is refused (negative)", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "workspace.read",
    });
    draw();
    await open();
    expect(readApprovalEligibility).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      APPROVAL,
      "fleet",
    );
    expect(screen.getByTestId("eligibility-unread")).toHaveTextContent(
      "could not be read again (workspace.read)",
    );
    // The recorded evaluation is still on screen, and the decision is still
    // available: a refused read of the clause is not a reason to stop a person
    // answering the call.
    expect(within(dialog()).getByTestId("eligibility")).toHaveTextContent(
      "Rule small-vendor-payments did not release this call.",
    );
    expect(within(dialog()).getByTestId("approve")).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("says no rule covered a call the clause never judged", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { settlement: null, eligibility: null },
    });
    draw(null);
    await open();
    expect(within(dialog()).getByTestId("eligibility")).toHaveTextContent(
      "No auto-approval rule covered this call, so it waited for a person.",
    );
  });
});

describe("approval refusal recovery", () => {
  it.each([
    ["no_principal", "Sign in again"],
    ["no_role_covers_all_tags", "No single organization role"],
    ["not_an_approver", "you are not one of them"],
    ["agent_cannot_resolve_own_mandate", "A person answers"],
    ["new_policy_refusal", "The decision was refused (new_policy_refusal)"],
  ])("explains refusal %s without changing the call", async (code, copy) => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code,
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent(copy);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(within(dialog()).getByTestId("approve")).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("reports a generic invalid decision without asking for a denial note", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent(
      "The decision was refused before it was sent.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names the access request holding a decision", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "arq_waiting",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent(
      "Your access request arq_waiting is still waiting.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("recovers from a rejected decision transport and permits retry", async () => {
    resolveApprovalAction.mockRejectedValueOnce(new Error("connection lost"));
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent("action_failed");
    expect(router.refresh).not.toHaveBeenCalled();
    expect(within(dialog()).getByTestId("approve")).not.toHaveAttribute(
      "aria-disabled",
    );
    await user.click(within(dialog()).getByTestId("approve"));
    expect(resolveApprovalAction).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledOnce();
    });
  });

  it("keeps a decision available when the freshness read itself waits for access", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "arq_waiting",
    });
    draw();
    await open();
    expect(screen.getByTestId("eligibility-unread")).toHaveTextContent(
      "pending_approval",
    );
    expect(within(dialog()).getByTestId("approve")).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("the eligibility line on a call a rule would have released", () => {
  const qualified: AutoEligibility = {
    ruleRef: "small-vendor-payments",
    ok: true,
    reasons: [],
    floor: false,
  };

  // #3521: the line names a mandate only on a row that records one.
  it("names the mandate that asked for a person, on a row that records one", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { settlement: null, eligibility: qualified },
    });
    draw(qualified, "mnd_4f2a9c");
    await open();
    expect(within(dialog()).getByTestId("eligibility")).toHaveTextContent(
      "Rule small-vendor-payments would have released this call. Mandate mnd_4f2a9c asked for a person anyway.",
    );
  });

  it("says what the record holds on a row that names no mandate (negative)", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { settlement: null, eligibility: qualified },
    });
    draw(qualified, null);
    await open();
    const line = within(dialog()).getByTestId("eligibility");
    expect(line).toHaveTextContent(
      "the record names no mandate that asked for one.",
    );
    expect(line).not.toHaveTextContent("A mandate asked");
  });
});

describe("the decision note", () => {
  // #3521: the cap comes from the contract, through the app's mirror, not a
  // literal of the dialog's own.
  it("caps the reason at the contract's bound", async () => {
    draw();
    await open();
    expect(within(dialog()).getByLabelText("Reason")).toHaveAttribute(
      "maxlength",
      String(APPROVAL_NOTE_MAX),
    );
  });

  it("names the bound when the server refuses an overlong note (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "note_too_long",
      field: "note",
    });
    draw();
    const user = await open();
    await user.click(within(dialog()).getByTestId("approve"));
    expect(await decisionFailure()).toHaveTextContent(
      "The reason is longer than 2000 characters.",
    );
  });
});
