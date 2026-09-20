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
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoEligibility } from "@/data/contracts/approvals";
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

function draw(recorded: AutoEligibility | null = eligibility) {
  render(
    <IntlProvider>
      <ApprovalDecision
        approvalId={APPROVAL}
        tool="stripe__create_payment"
        eligibility={recorded}
        org="acme"
        ws="core-platform"
        on="fleet"
      />
    </IntlProvider>,
  );
}

const dialog = () => screen.getByTestId("approval-decision");

async function open() {
  // `delay: null` keeps every interaction synchronous; the default wraps each
  // in a timer, which under the package's coverage run costs more than the
  // case timeout allows.
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByTestId("decide"));
  return user;
}

beforeEach(() => {
  router.refresh.mockReset();
  resolveApprovalAction.mockReset();
  readApprovalEligibility.mockReset();
  readApprovalEligibility.mockResolvedValue({
    ok: true,
    value: { resolvedBy: null, eligibility },
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
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("approval-decision")).toBeNull();
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
    expect(router.refresh).toHaveBeenCalledOnce();
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
    expect(screen.getByTestId("approval-decision-failure")).toHaveTextContent(
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
    expect(screen.getByTestId("approval-decision-failure")).toHaveTextContent(
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
    expect(screen.getByTestId("approval-decision-failure")).toHaveTextContent(
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
    expect(screen.getByTestId("approval-decision-failure")).toHaveTextContent(
      "Nothing was billed.",
    );
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
      const alert = screen.getByTestId("approval-decision-failure");
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
      within(screen.getByTestId("approval-decision-failure")).queryByTestId(
        "approval-decision-billing",
      ),
    ).toBeNull();
  });

  it("names the decision in flight while the write is out", async () => {
    let settle: (value: unknown) => void = () => undefined;
    resolveApprovalAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    draw();
    const user = await open();
    await user.type(within(dialog()).getByLabelText("Reason"), "no");
    await user.click(within(dialog()).getByTestId("deny"));
    const deny = within(dialog()).getByTestId("deny");
    expect(deny).toHaveTextContent("Denying");
    expect(deny).toHaveAttribute("aria-disabled", "true");
    settle({
      ok: true,
      value: { approvalId: APPROVAL, resolution: "denied", mandate: null },
    });
  });
});

describe("the evaluation the dialog reads again", () => {
  it("holds both decisions until the freshness read settles", async () => {
    const read = Promise.withResolvers<unknown>();
    readApprovalEligibility.mockReturnValue(read.promise);
    draw();
    const user = await open();
    for (const decision of ["approve", "deny"]) {
      expect(within(dialog()).getByTestId(decision)).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.click(within(dialog()).getByTestId(decision));
    }
    expect(resolveApprovalAction).not.toHaveBeenCalled();
    await act(async () =>
      read.resolve({ ok: true, value: { resolvedBy: null, eligibility } }),
    );
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
    expect(screen.getByTestId("eligibility-unread")).toHaveTextContent(
      "action_failed",
    );
    expect(screen.queryByTestId("eligibility-checking")).toBeNull();
    expect(within(dialog()).getByTestId("approve")).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("discards a read that settles after its dialog closes", async () => {
    const first = Promise.withResolvers<unknown>();
    readApprovalEligibility.mockReturnValueOnce(first.promise);
    draw();
    const user = await open();
    await user.keyboard("{Escape}");
    await act(async () =>
      first.resolve({
        ok: true,
        value: { resolvedBy: "user:stale", eligibility },
      }),
    );
    const second = Promise.withResolvers<unknown>();
    readApprovalEligibility.mockReturnValueOnce(second.promise);
    await user.click(screen.getByTestId("decide"));
    expect(screen.queryByTestId("approval-settled")).toBeNull();
    expect(screen.getByTestId("eligibility-checking")).toBeInTheDocument();
    await act(async () =>
      second.resolve({ ok: true, value: { resolvedBy: null, eligibility } }),
    );
  });

  it("refuses to decide a call somebody else already answered", async () => {
    readApprovalEligibility.mockResolvedValue({
      ok: true,
      value: { resolvedBy: "user:usr_marcusbell", eligibility },
    });
    draw();
    await open();
    expect(screen.getByTestId("approval-settled")).toHaveTextContent(
      "already resolved by user:usr_marcusbell",
    );
    const user = userEvent.setup({ delay: null });
    await user.click(within(dialog()).getByTestId("approve"));
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
      value: { resolvedBy: null, eligibility: null },
    });
    draw(null);
    await open();
    expect(within(dialog()).getByTestId("eligibility")).toHaveTextContent(
      "No auto-approval rule covered this call, so it waited for a person.",
    );
  });
});
