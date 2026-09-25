// @vitest-environment jsdom
// The writes one assistant turn parked, as cards in the thread (#4162).
//
// Each case is a state the approval row can be in, because the card shows the
// row and never what the flyout remembers: waiting with Approve and Deny, the
// decision in flight, approved with what became of the call, denied with the
// way on, expired, a second viewer who answered first, and a read or a write
// that failed. The decision goes through Fleet's own action as the signed-in
// person, so what it sends is asserted here too.
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
import type { resolveApprovalAction as ResolveApprovalAction } from "@/features/fleet/client";
import type { ActionResult } from "@/server/kernel";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type {
  ParkedApprovalRows,
  ParkedExecution,
} from "./assistant-approval-actions";

const { router, readParkedApprovals, resolveApprovalAction } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    readParkedApprovals:
      vi.fn<
        (
          org: string,
          ws: string,
          runId: string,
        ) => Promise<ActionResult<ParkedApprovalRows>>
      >(),
    resolveApprovalAction: vi.fn<typeof ResolveApprovalAction>(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The run and billing links render through SafeLink, and `next/link` wants a
// router this render does not mount.
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("./assistant-approval-actions", () => ({ readParkedApprovals }));
vi.mock("@/features/fleet/client", () => ({ resolveApprovalAction }));

const { AssistantParkedApprovals, PARKED_POLL_MAX, PARKED_POLL_MS } =
  await import("./assistant-parked-approvals");

const APPROVAL = "apr_q8t1";
const RUN = "arun_01k9";
const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const card = (expiresAt = inMinutes(4)) => ({
  approvalId: APPROVAL,
  capability: "retire_agent",
  expiresAt,
});

function draw(cards = [card()]) {
  render(
    <IntlProvider>
      <AssistantParkedApprovals
        org="acme"
        ws="core-platform"
        runId={RUN}
        cards={cards}
      />
    </IntlProvider>,
  );
}

const waitingRow = (expiresAt = inMinutes(4)): ParkedApprovalRows => ({
  rows: [{ id: APPROVAL, state: "waiting", expiresAt }],
});

const resolvedRow = (
  state: "approved" | "denied" | "expired",
  execution: ParkedExecution | null,
  resolvedBy: string | null = "user:usr_other",
): ParkedApprovalRows => ({
  rows: [
    {
      id: APPROVAL,
      state,
      resolvedBy,
      resolvedAt: new Date().toISOString(),
      execution,
    },
  ],
});

const RAN = { status: "succeeded", runId: "arun_resumed", reason: null };

const outcome = () => screen.getByTestId("assistant-parked-outcome");

beforeEach(() => {
  router.refresh.mockReset();
  readParkedApprovals.mockReset();
  resolveApprovalAction.mockReset();
  readParkedApprovals.mockResolvedValue({ ok: true, value: waitingRow() });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
  vi.useRealTimers();
});

describe("a parked write that waits", () => {
  it("reads its row for the turn's run and offers Approve and Deny", async () => {
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    expect(readParkedApprovals).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      RUN,
    );
    expect(outcome()).toHaveTextContent("Waits for a decision until");
    expect(screen.getByText("retire_agent")).toBeTruthy();
    expect(screen.getByTestId("assistant-parked-approve")).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByLabelText("Reason")).toBeTruthy();
  });

  it("holds the decision while the first read is in flight", async () => {
    readParkedApprovals.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    draw();
    expect(outcome()).toHaveTextContent("Reading this approval…");
    const approve = screen.getByTestId("assistant-parked-approve");
    expect(approve).toHaveAttribute("aria-disabled", "true");
    await user.click(approve);
    expect(resolveApprovalAction).not.toHaveBeenCalled();
  });

  it("still lets the person decide when the row could not be read", async () => {
    readParkedApprovals.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "read_failed",
    });
    draw();
    expect(
      await screen.findByTestId("assistant-parked-unread"),
    ).toHaveTextContent("read_failed");
    expect(outcome()).toHaveAttribute("data-state", "waiting");
    expect(screen.getByTestId("assistant-parked-approve")).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("approve", () => {
  it("approves as the signed-in person through Fleet's action, and says the call ran", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: true,
      value: {
        approvalId: APPROVAL,
        resolution: "approved",
        mandate: null,
        execution: RAN,
      },
    });
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("approved", RAN, "user:usr_me"),
    });
    await user.click(screen.getByTestId("assistant-parked-approve"));

    // Fleet's action with the approval and the viewer's slugs, and nothing
    // that names the turn or its run.
    expect(resolveApprovalAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { approvalId: APPROVAL, decision: "approved", note: "" },
    );
    await waitFor(() => {
      expect(outcome()).toHaveTextContent("Approved. The call ran.");
    });
    expect(screen.getByTestId("assistant-parked-run")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/arun_resumed",
    );
    expect(screen.queryByTestId("assistant-parked-approve")).toBeNull();
    // Fleet and the drawer re-read, and the card reads its row again.
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(readParkedApprovals).toHaveBeenCalledTimes(2);
    });
  });

  it("names the decision in flight", async () => {
    resolveApprovalAction.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    await user.click(screen.getByTestId("assistant-parked-approve"));
    expect(screen.getByTestId("assistant-parked-approve")).toHaveTextContent(
      "Approving…",
    );
    expect(screen.getByTestId("assistant-parked-deny")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the decision's answer over a read that started before it", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: true,
      value: {
        approvalId: APPROVAL,
        resolution: "approved",
        mandate: null,
        execution: RAN,
      },
    });
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    // The re-read answers the row as it stood before the decision landed.
    await user.click(screen.getByTestId("assistant-parked-approve"));
    await waitFor(() => {
      expect(readParkedApprovals).toHaveBeenCalledTimes(2);
    });
    expect(outcome()).toHaveTextContent("Approved. The call ran.");
  });

  it("watches a call left queued until the row says it ran", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("approved", {
        status: "queued",
        runId: null,
        reason: null,
      }),
    });
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveTextContent(
        "Approved. The call is queued to run.",
      );
    });
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("approved", RAN),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARKED_POLL_MS);
    });
    await waitFor(() => {
      expect(outcome()).toHaveTextContent("Approved. The call ran.");
    });
    const reads = readParkedApprovals.mock.calls.length;
    // Settled, so no further read is scheduled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARKED_POLL_MS * 3);
    });
    expect(readParkedApprovals).toHaveBeenCalledTimes(reads);
  });

  it("stops watching after its bound and offers Check again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queued = resolvedRow("approved", {
      status: "queued",
      runId: null,
      reason: null,
    });
    readParkedApprovals.mockResolvedValue({ ok: true, value: queued });
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "approved");
    });
    for (let i = 0; i < PARKED_POLL_MAX + 2; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARKED_POLL_MS);
      });
    }
    // The mount read plus the bound, and no more.
    expect(readParkedApprovals).toHaveBeenCalledTimes(PARKED_POLL_MAX + 1);
    const check = screen.getByTestId("assistant-parked-check");
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("approved", RAN),
    });
    await act(async () => {
      check.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => {
      expect(outcome()).toHaveTextContent("Approved. The call ran.");
    });
  });

  it.each([
    [
      "indeterminate",
      { status: "indeterminate", runId: "arun_resumed", reason: null },
      "Approved, but the call’s outcome is unknown. Check its run before you ask for it again.",
    ],
    [
      "failed",
      { status: "failed", runId: null, reason: "requester_access_revoked" },
      "Approved, but the call did not run (requester_access_revoked).",
    ],
    [
      "expired before it ran",
      { status: "expired", runId: null, reason: "approval_expired" },
      "Approved, but the approval expired before the call could run.",
    ],
    [
      "dispatched",
      { status: "dispatched", runId: "arun_resumed", reason: null },
      "Approved. The call started and finishes in the background.",
    ],
  ])(
    "says what the row records when the call %s",
    async (_why, execution, text) => {
      readParkedApprovals.mockResolvedValue({
        ok: true,
        value: resolvedRow("approved", execution),
      });
      draw();
      await waitFor(() => {
        expect(outcome()).toHaveTextContent(text);
      });
    },
  );

  it("names the rule that decided a call no person looked at", async () => {
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("approved", RAN, "policy:small-retirements"),
    });
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveTextContent(
        "A rule decided it: small-retirements.",
      );
    });
  });
});

describe("deny", () => {
  it("denies with the reason, posts the denial and lets the person continue", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: true,
      value: {
        approvalId: APPROVAL,
        resolution: "denied",
        mandate: null,
        execution: { status: "denied", runId: null, reason: null },
      },
    });
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    await user.type(screen.getByLabelText("Reason"), "not during the freeze");
    await user.click(screen.getByTestId("assistant-parked-deny"));
    expect(resolveApprovalAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        approvalId: APPROVAL,
        decision: "denied",
        note: "not during the freeze",
      },
    );
    await waitFor(() => {
      expect(outcome()).toHaveTextContent(
        "Denied. The call did not run. Ask stella for something else when you are ready.",
      );
    });
    expect(screen.queryByTestId("assistant-parked-deny")).toBeNull();
  });

  it("shows the refusal of a denial with no reason and keeps the decision open (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "note_required",
      field: "note",
    });
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    await user.click(screen.getByTestId("assistant-parked-deny"));
    expect(
      await screen.findByTestId("assistant-parked-failure"),
    ).toHaveTextContent("Write a reason before you deny this call.");
    expect(screen.getByTestId("assistant-parked-deny")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("expiry", () => {
  it("shows an approval whose deadline passed while it waited as expired, with no decision", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const soon = new Date(Date.now() + 2_000).toISOString();
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: waitingRow(soon),
    });
    draw([card(soon)]);
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    // list_approvals stops returning a row past its deadline.
    readParkedApprovals.mockResolvedValue({ ok: true, value: { rows: [] } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARKED_POLL_MS);
    });
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "expired");
    });
    expect(outcome()).toHaveTextContent(
      "This approval expired before anyone decided, so the call did not run.",
    );
    expect(screen.queryByTestId("assistant-parked-approve")).toBeNull();
  });

  it("reads a row the sweep resolved as expired", async () => {
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("expired", null, null),
    });
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "expired");
    });
    expect(screen.queryByTestId("assistant-parked-deny")).toBeNull();
  });
});

describe("a second viewer", () => {
  it("shows the decision another person already made, with no buttons", async () => {
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("approved", RAN),
    });
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveTextContent("Approved. The call ran.");
    });
    expect(screen.queryByTestId("assistant-parked-approve")).toBeNull();
  });

  it("reads the row again when another person answered first, and says so", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "approval_expired",
    });
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("denied", {
        status: "denied",
        runId: null,
        reason: null,
      }),
    });
    await user.click(screen.getByTestId("assistant-parked-approve"));
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "denied");
    });
    expect(screen.getByTestId("assistant-parked-first")).toHaveTextContent(
      "Someone else answered this approval before your decision reached it.",
    );
    expect(screen.queryByTestId("assistant-parked-failure")).toBeNull();
  });

  it("reads the row again when Fleet decided it while the card waited", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    readParkedApprovals.mockResolvedValue({
      ok: true,
      value: resolvedRow("approved", RAN),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARKED_POLL_MS);
    });
    await waitFor(() => {
      expect(outcome()).toHaveTextContent("Approved. The call ran.");
    });
  });
});

describe("a decision that did not land", () => {
  it("carries the handler's code when the person's roles cannot answer (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    await user.click(screen.getByTestId("assistant-parked-approve"));
    expect(
      await screen.findByTestId("assistant-parked-failure"),
    ).toHaveTextContent("org_role_required");
  });

  it("links the way out of an exhausted refusal (negative)", async () => {
    resolveApprovalAction.mockResolvedValue({
      ok: false,
      reason: "exhausted",
      code: "gau_exhausted",
    });
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    await user.click(screen.getByTestId("assistant-parked-approve"));
    const failure = await screen.findByTestId("assistant-parked-failure");
    expect(failure).toHaveTextContent("gau_exhausted");
    expect(within(failure).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/billing",
    );
  });

  it("says nothing changed when the action threw (negative)", async () => {
    resolveApprovalAction.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    draw();
    await waitFor(() => {
      expect(outcome()).toHaveAttribute("data-state", "waiting");
    });
    await user.click(screen.getByTestId("assistant-parked-approve"));
    expect(
      await screen.findByTestId("assistant-parked-failure"),
    ).toHaveTextContent(
      "The decision did not reach Oxagen (action_failed). Nothing changed. Try again.",
    );
  });
});
