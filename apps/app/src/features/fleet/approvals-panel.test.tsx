// @vitest-environment jsdom
// The approvals panel over its reads: one card per pending approval with its
// four hops, its expiry clock, the recorded auto-approval evaluation and the
// mandate bar, and the panel's own empty, denied and failed states, with an
// axe check in every one.
//
// Fleet no longer draws this panel (fleet.md: its "Waiting on a human" tile
// opens the shell's approvals drawer); the Run page's Approvals tab and the
// drawer do. So the panel is tested on its own, over the reads a caller hands
// it, where Fleet's suite used to test it through the page.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MandateList, MandateRow } from "@/data/contracts/mandates";
import type { ApprovalQueue } from "@/data/contracts/approvals";
import { type Read, readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  mandateAuthority,
  mandateList,
  mandateRow,
} from "@/test/mandate-views";
import { approvalItem, approvalQueue, NOW } from "./fleet.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
// Each card carries a decision control, a client component that reads the
// app router to re-read the panel after a decision.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  resolveApprovalAction: vi.fn(),
  readApprovalEligibility: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { ApprovalsPanel } = await import("./approvals-panel");

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "workspace.read",
} as const;
const DOWN = readError("run_index_unavailable", 503);
const NO_APPROVALS = approvalQueue([]);

/** The mandates a caller read, keyed as the panel takes them; empty when the read was refused. */
function mandatesOf(read: Read<MandateList> | undefined) {
  const map = new Map<string, MandateRow>();
  if (read?.ok) for (const m of read.value.mandates) map.set(m.id, m);
  return map;
}

async function renderPanel(reads: {
  approvals: Read<ApprovalQueue>;
  mandates?: Read<MandateList>;
}) {
  const { container } = render(
    <IntlProvider>
      <ApprovalsPanel
        approvals={reads.approvals}
        mandates={mandatesOf(reads.mandates)}
        now={NOW}
        org="acme"
        ws="core-platform"
      />
    </IntlProvider>,
  );
  return Promise.resolve({ container });
}

const approvalsSection = () =>
  screen.getByRole("region", { name: "Approvals" });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await expectNoAxe(document.body);
  cleanup();
});

describe("the approvals panel", () => {
  it("draws one card per pending approval with its four hops and expiry clock", async () => {
    await renderPanel({
      approvals: approvalQueue([
        approvalItem(),
        approvalItem({
          id: "apr_r2",
          runId: "arun_7k2m9q",
          tool: "merge_pull_request",
          agentKey: "acme.core.release-bot",
          requester: null,
          mandateId: "mnd_4f2a9c",
          rule: "mandate:mnd_4f2a9c:human_above:amount",
        }),
      ]),
      mandates: mandateList([mandateRow()]),
    });
    const section = approvalsSection();
    expect(section).toHaveTextContent("2 parked");
    const [first, second] = within(section).getAllByTestId("approval");
    // Four hops, in the order the chain runs: who asked, which agent, which
    // action, which rule. A hop the store does not record says so.
    expect(first).toHaveTextContent(
      "create_releaseWho askedusr_marcusbellWhich agentnot recordedWhich actioncreate_releaseWhich rulenot recorded",
    );
    expect(first).toHaveTextContent("Times out in 7:30, then the call ends");
    expect(within(first ?? section).queryByRole("link")).toBeNull();
    expect(second).toHaveTextContent("Which agentacme.core.release-bot");
    expect(second).toHaveTextContent("Who askednot recorded");
    // The rule hop names the mandate, because a rule id of this form is only
    // legible beside it.
    expect(second).toHaveTextContent(
      "Which rulemandate:mnd_4f2a9c:human_above:amount (under mandate mnd_4f2a9c)",
    );
    expect(
      within(second ?? section).getByRole("link", { name: "Open run" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_7k2m9q");
  });

  it("says no rule covered a call the auto-approval clause never judged", async () => {
    await renderPanel({
      approvals: approvalQueue([approvalItem()]),
    });
    expect(
      within(approvalsSection()).getByTestId("eligibility"),
    ).toHaveTextContent(
      "No auto-approval rule covered this call, so it waited for a person.",
    );
  });

  it("names the rule, its reasons and its floor when one judged the call and refused it", async () => {
    await renderPanel({
      approvals: approvalQueue([
        approvalItem({
          autoEligibility: {
            ruleRef: "small-vendor-payments",
            ok: false,
            reasons: [
              "measure_above_ceiling:amount",
              "tainted_input",
              "not_a_code",
            ],
            floor: true,
          },
        }),
      ]),
    });
    const line = within(approvalsSection()).getByTestId("eligibility");
    expect(line).toHaveTextContent(
      "Rule small-vendor-payments did not release this call.",
    );
    expect(line).toHaveTextContent(
      "The call is over the rule's ceiling on amount.",
    );
    expect(line).toHaveTextContent(
      "The arguments derive from untrusted input.",
    );
    // A code this build has no copy for is printed as recorded rather than
    // given a sentence written for another condition.
    expect(line).toHaveTextContent("Recorded as not_a_code.");
    expect(
      within(approvalsSection()).getByTestId("eligibility-floor"),
    ).toHaveTextContent("floor no rule can lift");
  });

  // §6.9 part 3: a mandate's own approval rule outranks any workspace rule, so
  // a call a rule would have released can still be parked.
  it("says a rule would have released a call a mandate parked anyway", async () => {
    await renderPanel({
      approvals: approvalQueue([
        approvalItem({
          autoEligibility: {
            ruleRef: "small-vendor-payments",
            ok: true,
            reasons: [],
            floor: false,
          },
        }),
      ]),
    });
    expect(
      within(approvalsSection()).getByTestId("eligibility"),
    ).toHaveTextContent(
      "Rule small-vendor-payments would have released this call. A mandate asked for a person anyway.",
    );
  });

  it("marks a count the read could not finish", async () => {
    await renderPanel({
      approvals: approvalQueue([approvalItem()], true),
    });
    expect(approvalsSection()).toHaveTextContent("1+ parked");
  });

  it("says nothing is waiting on a human when the queue is empty", async () => {
    await renderPanel({ approvals: NO_APPROVALS });
    expect(approvalsSection()).toHaveTextContent(
      "Nothing is waiting on a human.",
    );
    expect(within(approvalsSection()).queryAllByTestId("approval")).toEqual([]);
  });

  it("names the permission a denied read needed, with no cards (negative)", async () => {
    await renderPanel({ approvals: DENIED });
    expect(approvalsSection()).toHaveTextContent(
      "You cannot see Approvals in this workspace. Your roles do not include workspace.read",
    );
    expect(approvalsSection()).not.toHaveTextContent("parked");
  });

  it("names the code a failed read answered (negative)", async () => {
    await renderPanel({ approvals: DOWN });
    expect(approvalsSection()).toHaveTextContent(
      "Approvals could not be loaded: the control plane answered run_index_unavailable.",
    );
  });

  it("carries the request id of an access request still waiting (negative)", async () => {
    await renderPanel({
      approvals: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_91",
      },
    });
    expect(approvalsSection()).toHaveTextContent(
      "Access to Approvals is waiting for approval, request acr_91.",
    );
  });
});

describe("the approvals panel › the mandate bar", () => {
  const parked = approvalItem({ mandateId: "mnd_4f2a9c" });

  it("draws the bar of the mandate a parked call drew on", async () => {
    const { container } = await renderPanel({
      approvals: approvalQueue([parked]),
      mandates: mandateList([mandateRow()]),
    });
    const bar = within(approvalsSection()).getByTestId("mandate-bar");
    expect(bar).toHaveAttribute("data-measure", "amount");
    expect(bar).toHaveTextContent("$615.82");
    // The measure is on the card, not only in a data attribute: this panel is
    // where a mandate draws one bar per measure.
    expect(bar).toHaveTextContent("Remaining authority · amount · monthly");
    expect(within(bar).getByRole("img")).toHaveAccessibleName(
      "amount: $1,204.18 settled, $180.00 reserved by calls in flight, $615.82 remaining of $2,000.00",
    );
    await expectNoAxe(container);
  });

  it("says what the bar's figures are counted over, since a parked call can outlive a period", async () => {
    await renderPanel({
      approvals: approvalQueue([parked]),
      mandates: mandateList([mandateRow()]),
    });
    expect(
      within(approvalsSection()).getByTestId("mandate-period-basis"),
    ).toHaveTextContent("A reservation this call made in an earlier period");
  });

  it("says nothing about a period on a card with no bar (negative)", async () => {
    await renderPanel({
      approvals: approvalQueue([approvalItem()]),
    });
    expect(
      within(approvalsSection()).queryByTestId("mandate-period-basis"),
    ).toBeNull();
  });

  it("draws the card without its bar when the ledger refuses the viewer (negative)", async () => {
    const { container } = await renderPanel({
      approvals: approvalQueue([parked]),
      mandates: { ok: false, reason: "denied", permission: "org.billing" },
    });
    expect(
      within(approvalsSection()).getByTestId("approval"),
    ).toBeInTheDocument();
    expect(within(approvalsSection()).queryByTestId("mandate-bar")).toBeNull();
    await expectNoAxe(container);
  });

  it("names a mandate the page did not read rather than drawing nothing (negative)", async () => {
    const { container } = await renderPanel({
      approvals: approvalQueue([approvalItem({ mandateId: "mnd_absent" })]),
      mandates: mandateList([mandateRow()], 100),
    });
    const section = approvalsSection();
    expect(within(section).queryByTestId("mandate-bar")).toBeNull();
    expect(within(section).getByTestId("mandate-unread")).toHaveTextContent(
      "Drew on mandate mnd_absent",
    );
    await expectNoAxe(container);
  });

  it("names the mandate on a card the viewer may not read the ledger for (negative)", async () => {
    await renderPanel({
      approvals: approvalQueue([parked]),
      mandates: { ok: false, reason: "denied", permission: "org.billing" },
    });
    expect(
      within(approvalsSection()).getByTestId("mandate-unread"),
    ).toHaveTextContent("mnd_4f2a9c");
  });

  it("names no mandate on a card that drew on none (negative)", async () => {
    await renderPanel({
      approvals: approvalQueue([approvalItem()]),
    });
    expect(
      within(approvalsSection()).queryByTestId("mandate-unread"),
    ).toBeNull();
  });

  // A mandate limited per call only has no denominator, so every `MandateBar`
  // draws nothing — and the card used to print a caveat about the period it
  // was not counting, over that emptiness, while suppressing the fallback that
  // would at least have named the mandate.
  it("names a per-call-only mandate instead of drawing an empty card", async () => {
    await renderPanel({
      approvals: approvalQueue([parked]),
      mandates: mandateList([
        mandateRow({
          authority: [
            mandateAuthority({
              perPeriod: null,
              remaining: null,
              settledRatio: null,
              reservedRatio: null,
            }),
          ],
        }),
      ]),
    });
    const card = within(approvalsSection()).getByTestId("approval");
    expect(within(card).queryByTestId("mandate-bar")).toBeNull();
    expect(within(card).queryByTestId("mandate-period-basis")).toBeNull();
    const line = within(card).getByTestId("mandate-per-call-only");
    expect(line.textContent).toContain("mnd_4f2a9c");
    expect(line.textContent).toContain("limits these per call only");
    expect(line.textContent).toContain("$250.00");
    expect(line.textContent).toContain("amount");
  });

  it("keeps the period caveat when a measure does have a period limit", async () => {
    await renderPanel({
      approvals: approvalQueue([parked]),
      mandates: mandateList([mandateRow()]),
    });
    const card = within(approvalsSection()).getByTestId("approval");
    expect(
      within(card).getByTestId("mandate-period-basis"),
    ).toBeInTheDocument();
    expect(within(card).queryByTestId("mandate-per-call-only")).toBeNull();
  });

  // A mandate's measures are a partition, not an either/or. Keying the
  // fallback on "are there any bars" hid the per-call measures of a mandate
  // that had one of each.
  it("draws the bars and names the per-call-only measures beside them", async () => {
    await renderPanel({
      approvals: approvalQueue([parked]),
      mandates: mandateList([
        mandateRow({
          authority: [
            mandateAuthority(),
            mandateAuthority({
              measure: "tax",
              perPeriod: null,
              remaining: null,
              settledRatio: null,
              reservedRatio: null,
            }),
          ],
        }),
      ]),
    });
    const card = within(approvalsSection()).getByTestId("approval");
    const bars = within(card).getAllByTestId("mandate-bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute("data-measure", "amount");
    // The period caveat belongs to the bar, and the bar is there.
    expect(
      within(card).getByTestId("mandate-period-basis"),
    ).toBeInTheDocument();
    // And the measure with no period is named rather than dropped.
    const line = within(card).getByTestId("mandate-per-call-only");
    expect(line.textContent).toContain("tax");
    expect(line.textContent).toContain("$250.00");
    expect(line.textContent).not.toContain("amount");
  });
});
