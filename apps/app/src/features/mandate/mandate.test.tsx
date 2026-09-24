// @vitest-environment jsdom
// The mandate page over a fake DataSource: the loaded record, the mandate that
// has never been drawn on, the skeleton, the read error and the refusal, each
// with an axe check (INV-26). The two writes are proven in actions.test.ts, and
// what the ledger's search, facet and pager select in view.test.ts; this suite
// is about what the page renders and what it refuses to claim.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import type { MandateRow } from "@/data/contracts/mandates";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  callsAuthority,
  mandateAuthority,
  mandateDetail,
  mandateDetailRead,
  mandateMovement,
  mandateRow,
} from "@/test/mandate-views";
import { mandateSource } from "./mandate.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({
  changeMandateLimits: vi.fn(),
  revokeMandate: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Mandate, MandateLoading } = await import("./mandate");

const viewer = (orgRole: OrgRole) =>
  unsafeMint(WsCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "a-intel",
    orgName: "Anderson Intelligence Corp.",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole: "member",
  });

const ctx = viewer("billing");

type DetailRead = Parameters<typeof mandateSource>[0];

async function renderMandate(
  read: DetailRead,
  query: Readonly<Record<string, string>> = {},
  options: { mandate?: string; as?: OrgRole } = {},
) {
  const { source, calls } = mandateSource(read);
  const element = await Mandate({
    ctx: options.as === undefined ? ctx : viewer(options.as),
    source,
    mandate: options.mandate ?? "mnd_4f2a9c",
    searchParams: query,
  });
  const view = render(<IntlProvider>{element}</IntlProvider>);
  return { calls, ...view };
}

const movements = () => screen.getAllByTestId("ledger-movement");

// `cleanup()` runs whether or not the axe check passes. Without the `finally`
// one violation unmounts nothing, the next render appends beside the last, and
// every test after it inherits the leftover markup: the violation is reported
// again, `getByTestId` finds two panels, and a filtered ledger counts rows a
// previous test rendered. One accessibility defect then reads as twelve
// unrelated failures, which is what it did.
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Mandate › loaded", () => {
  it("reads the one mandate the URL names, by its public id", async () => {
    const { calls } = await renderMandate(mandateDetailRead());
    expect(calls).toEqual([[ctx, "mnd_4f2a9c"]]);
  });

  it("names the page Mandate and the mandate by its id", async () => {
    await renderMandate(mandateDetailRead());
    expect(screen.getByText("Mandate")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "mnd_4f2a9c" }),
    ).toBeInTheDocument();
  });

  // Gold is identity and never state: the status reads as a dot and a word, so
  // it survives greyscale.
  it("reads the status as a word beside its dot", async () => {
    await renderMandate(mandateDetailRead());
    const badge = screen.getByText("active");
    expect(badge).toHaveAttribute("data-status", "active");
  });

  it("shows four tiles, each with its figure and the basis of that figure", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          authority: [mandateAuthority(), callsAuthority()],
        }),
      }),
    );
    const tiles = screen.getByTestId("mandate-tiles");
    for (const heading of ["Per call", "Per period", "Settled", "Remaining"]) {
      expect(within(tiles).getByText(heading)).toBeInTheDocument();
    }
    const text = tiles.textContent;
    // The limits and the ledger's own accounting, each in its measure's form.
    for (const figure of ["$250.00", "$2,000.00", "$615.82", "50 calls"]) {
      expect(text).toContain(figure);
    }
    // Every money number carries its basis.
    expect(text).toContain("from the ledger's settlements");
    expect(text).toContain("reserved at decision time");
  });

  it("lists each movement with its measure, figure, state and external effect", async () => {
    await renderMandate(mandateDetailRead());
    const [row] = movements();
    expect(row).toHaveAttribute("data-state", "settle");
    const text = row?.textContent ?? "";
    expect(text).toContain("amount");
    expect(text).toContain("$884.60");
    expect(text).toContain("settled");
    expect(text).toContain("pi_3QaL8f2Xk");
  });

  // Receipt frames have no read, so the column says so rather than opening a
  // dialog onto nothing or printing a zero.
  it("says a receipt is not recorded rather than offering one (negative)", async () => {
    await renderMandate(mandateDetailRead());
    const [row] = movements();
    if (!row) throw new Error("the ledger rendered no movement row");
    expect(
      row.querySelector('[data-receipt="not-recorded"]')?.textContent,
    ).toBe("not recorded");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("says the external effect is not recorded on a reservation (negative)", async () => {
    await renderMandate(
      mandateDetailRead({
        ledger: [
          mandateMovement({
            kind: "reserve",
            externalEffectRef: null,
            value: {
              kind: "money",
              money: { micros: "2450000000", currency: "USD" },
            },
          }),
        ],
      }),
    );
    const [row] = movements();
    expect(row).toHaveAttribute("data-state", "reserve");
    expect(row?.textContent).toContain("reserved");
    expect(row?.textContent).toContain("not recorded");
  });

  it("carries no raw identifier into the ledger table (negative)", async () => {
    await renderMandate(mandateDetailRead());
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it("links to the agent the record names, since the route carries no agent", async () => {
    await renderMandate(mandateDetailRead());
    expect(screen.getByRole("link", { name: "invoice-bot" })).toHaveAttribute(
      "href",
      "/a-intel/core-platform/agents/invoice-bot/permissions",
    );
  });

  it("shows the grant: the agent, who granted it, the effect, the scope and the window", async () => {
    await renderMandate(mandateDetailRead());
    const grant = screen.getByTestId("mandate-grant");
    const text = grant.textContent;
    for (const fact of [
      "invoice-bot",
      "usr_priyanatarajan",
      "Billing at grant",
      "moves_money",
      "stripe__create_payment@*",
      "vendor:aws",
    ]) {
      expect(text).toContain(fact);
    }
  });

  it("spells the approval rule rather than printing its shape", async () => {
    await renderMandate(mandateDetailRead());
    const grant = screen.getByTestId("mandate-grant");
    expect(grant.textContent).toContain("above $100.00");
    expect(grant.textContent).toContain("always answers for moves_money");
  });

  // Approvers only mean something once something can park a call. The gate
  // fills `ruleIds` from a matching `alwaysHumanFor` tag or an exceeded
  // `humanAbove` threshold, and proceeds when it is empty
  // (`packages/rules/src/mandates.ts`). A mandate with neither parks nothing,
  // so naming approvers on it would describe a review path that never runs.
  it("says no call waits for a person when the rule can park none", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          approval: { humanAbove: [], alwaysHumanFor: [], approvers: [] },
        }),
      }),
    );
    expect(screen.getByTestId("mandate-grant").textContent).toContain(
      "no call on this mandate waits for a person",
    );
  });

  // Once a tag can park a call, an empty approvers list is a rule and not an
  // absence: the consequence roles decide. Printing it as empty would say the
  // opposite of what it means.
  it("reads an empty approver list as the consequence roles", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          approval: {
            humanAbove: [],
            alwaysHumanFor: ["moves_money"],
            approvers: [],
          },
        }),
      }),
    );
    expect(screen.getByTestId("mandate-grant").textContent).toContain(
      "org roles accountable for the consequence",
    );
  });

  // A store that records no receipts cannot say a charge was accounted for.
  it("declines to claim the ledger reconciles, and points at Audit", async () => {
    await renderMandate(mandateDetailRead());
    const panel = screen.getByTestId("mandate-reconciliation");
    expect(
      panel.querySelector('[data-state="not-recorded"]'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: "Open the audit record" }),
    ).toHaveAttribute("href", "/a-intel/audit");
  });

  // What the read can establish, and no more: a ledger of exactly the bound
  // looks the same as one of the bound plus a thousand, so the line says what it
  // read and that it cannot tell whether there is more. Claiming truncation would
  // be a false statement about an audit record.
  it("says what the read bound was without claiming older movements exist", async () => {
    await renderMandate(mandateDetailRead({ readBound: 500 }));
    const notice = document.querySelector('[data-state="read-bound"]');
    expect(notice?.textContent).toContain("newest 500 movements");
    expect(notice?.textContent).toContain("cannot tell you whether");
  });

  it("says nothing about the bound when the answer came back short of it", async () => {
    await renderMandate(mandateDetailRead());
    expect(document.querySelector('[data-state="read-bound"]')).toBeNull();
  });

  // The gate fills `ruleIds` from a matching `alwaysHumanFor` tag or an exceeded
  // `humanAbove` threshold and proceeds when it is empty, and the contract
  // defaults both to empty. Naming approvers on such a mandate described a review
  // path that does not exist, on the record an operator reads to know what it
  // does.
  describe("a mandate with no approval trigger", () => {
    it("says nothing waits for a person, and names no approvers", async () => {
      await renderMandate(
        mandateDetailRead({
          mandate: mandateRow({
            approval: {
              humanAbove: [],
              alwaysHumanFor: [],
              approvers: ["Billing"],
            },
          }),
        }),
      );
      expect(
        document.querySelector('[data-approval="none"]'),
      ).toHaveTextContent("no call on this mandate waits for a person");
      // Not merely hidden: an approver list beside "nothing waits" would be the
      // same claim in two minds.
      expect(document.querySelector('[data-approval="approvers"]')).toBeNull();
    });

    it("names the approvers once a threshold can park a call", async () => {
      await renderMandate(mandateDetailRead());
      expect(document.querySelector('[data-approval="none"]')).toBeNull();
      expect(
        document.querySelector('[data-approval="approvers"]'),
      ).not.toBeNull();
    });
  });

  // `targetAllowed` (packages/rules/src/mandates/measures.ts) ends on
  // `rule.allow.length === 0`, so an empty allow list permits every target the
  // deny list does not name. The panel used to render that as "allow no pattern",
  // which reads as a mandate that permits nothing where enforcement permits
  // everything: the one misreading an authority record must not offer, because it
  // is the reassuring one.
  describe("a target rule with no allow pattern", () => {
    const withTargets = (targets: MandateRow["targets"]) =>
      mandateDetailRead({ mandate: mandateRow({ targets }) });

    it("says any target when nothing is allowed and nothing is denied", async () => {
      await renderMandate(
        withTargets([{ measure: "amount", allow: [], deny: [] }]),
      );
      const rule = document.querySelector('[data-target="amount"]');
      expect(rule).toHaveTextContent("allow any target");
      expect(rule).toHaveTextContent("deny no pattern");
    });

    it("says anything not denied when only a deny pattern is recorded", async () => {
      await renderMandate(
        withTargets([
          { measure: "amount", allow: [], deny: ["vendor:stripe"] },
        ]),
      );
      const rule = document.querySelector('[data-target="amount"]');
      expect(rule).toHaveTextContent("allow anything not denied");
      expect(rule).toHaveTextContent("deny vendor:stripe");
    });

    it("still lists the patterns when an allow list is recorded", async () => {
      await renderMandate(
        withTargets([
          { measure: "amount", allow: ["vendor:aws"], deny: ["*"] },
        ]),
      );
      const rule = document.querySelector('[data-target="amount"]');
      expect(rule).toHaveTextContent("allow vendor:aws");
      expect(rule).not.toHaveTextContent("any target");
    });
  });

  it("offers exactly one gold action, and both writes, on an active mandate", async () => {
    await renderMandate(mandateDetailRead());
    expect(
      screen.getByRole("button", { name: "Change limits" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  // A revoked mandate is refused by both handlers, so offering either control
  // would be offering a write the kernel is certain to refuse. A draft is not
  // this case: `revoke_mandate` accepts one, because declining a request is the
  // revocation of a mandate that never took effect, and `mandate-actions.test.tsx`
  // covers it.
  it("offers neither write on a revoked mandate (negative)", async () => {
    await renderMandate(
      mandateDetailRead({ mandate: mandateRow({ status: "revoked" }) }),
    );
    expect(screen.queryByRole("button", { name: "Change limits" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.getByText("revoked")).toHaveAttribute(
      "data-status",
      "revoked",
    );
  });
});

describe("Mandate › empty", () => {
  it("says the mandate has never been drawn on, and that remaining is the full limit", async () => {
    await renderMandate(mandateDetailRead({ ledger: [] }));
    const empty = document.querySelector('[data-state="empty"]');
    expect(empty?.textContent).toContain("never been drawn on");
    expect(empty?.textContent).toContain("remaining authority equals the full");
    expect(screen.queryAllByTestId("ledger-movement")).toHaveLength(0);
    // The tiles still carry the record's own figures: an empty ledger is not an
    // absent limit.
    expect(screen.getByTestId("mandate-tiles").textContent).toContain(
      "$2,000.00",
    );
  });
});

describe("Mandate › loading", () => {
  it("is the skeleton the design shows: four tile blocks and a panel of seven rows", () => {
    render(
      <IntlProvider>
        <MandateLoading />
      </IntlProvider>,
    );
    const skeleton = document.querySelector('[data-state="loading"]');
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    // No figure and no zero: a skeleton that flashed a zero would read as a
    // mandate with no authority.
    expect(skeleton?.textContent).toBe("");
    expect(document.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(
      4 * 3 + 7,
    );
  });
});

describe("Mandate › error", () => {
  it("names the code, offers Try again, and says nothing was changed", async () => {
    await renderMandate(readError("mandate_ledger_unavailable", 503));
    const panel = screen.getByTestId("mandate-error");
    expect(panel.textContent).toContain("This mandate could not be loaded");
    expect(panel.textContent).toContain("mandate_ledger_unavailable");
    expect(panel.textContent).toContain("503");
    expect(panel.textContent).toContain("Nothing was changed");
    expect(
      within(panel).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/a-intel/core-platform/mandates/mnd_4f2a9c");
    // The design's error state: the state wrap in the failed tone.
    expect(
      panel.querySelector("[data-state-icon]")?.getAttribute("data-state-icon"),
    ).toBe("failed");
  });

  it("names the instant the read was attempted", async () => {
    await renderMandate(readError("mandate_ledger_unavailable", 503));
    expect(screen.getByTestId("mandate-error").textContent).toContain(
      "Read at",
    );
  });

  it("renders no header naming the mandate beside a body that could not load it (negative)", async () => {
    await renderMandate(readError("mandate_ledger_unavailable", 503));
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByTestId("mandate-tiles")).toBeNull();
  });
});

describe("Mandate › access denied", () => {
  it("names the permission, the signed-in role and who decides, and offers a way out", async () => {
    await renderMandate(
      { ok: false, reason: "denied", permission: "org.billing" },
      {},
      { as: "member" },
    );
    const panel = screen.getByTestId("mandate-denied");
    expect(panel.textContent).toContain("You cannot see this mandate");
    expect(panel.textContent).toContain("org.billing");
    expect(panel.textContent).toContain("Signed in as: Member");
    expect(panel.textContent).toContain("Needed:");
    expect(panel.textContent).toContain("Decided by:");
    expect(panel.textContent).toContain(
      "An owner can grant an accountable role",
    );
    expect(
      within(panel).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/a-intel/core-platform");
    expect(
      panel.querySelector("[data-state-icon]")?.getAttribute("data-state-icon"),
    ).toBe("denied");
  });

  it("names the access request while one is waiting", async () => {
    await renderMandate({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "areq_01K4",
    });
    expect(screen.getByTestId("mandate-pending").textContent).toContain(
      "areq_01K4",
    );
  });
});

describe("Mandate › not found", () => {
  // A mandate this workspace has not recorded, and an address that could never
  // name one, are both 404s. The second would otherwise reach the kernel and
  // come back as invalid_input, which renders as "the store is down".
  it("is a 404 for a mandate the workspace has not recorded", async () => {
    await expect(renderMandate(readError("not_found", 404))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("is a 404 for an address that is not a mandate id, without reading (negative)", async () => {
    const { source, calls } = mandateSource(readOk(mandateDetail()));
    await expect(
      Mandate({
        ctx,
        source,
        mandate: "not-a-mandate",
        searchParams: {},
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls).toEqual([]);
  });
});

describe("Mandate › the ledger's search, facet and pager", () => {
  const three = () => [
    mandateMovement({ measure: "amount", externalEffectRef: "pi_3QaL8f2Xk" }),
    mandateMovement({
      kind: "reserve",
      measure: "amount",
      externalEffectRef: null,
    }),
    mandateMovement({
      kind: "release",
      measure: "calls",
      value: { kind: "count", count: "1", unit: "calls" },
      externalEffectRef: null,
    }),
  ];

  it("narrows to the movements a search matches", async () => {
    await renderMandate(mandateDetailRead({ ledger: three() }), {
      q: "pi_3QaL",
    });
    expect(movements()).toHaveLength(1);
    expect(movements()[0]?.textContent).toContain("pi_3QaL8f2Xk");
  });

  it("narrows to one state on the facet", async () => {
    await renderMandate(mandateDetailRead({ ledger: three() }), {
      state: "release",
    });
    expect(movements()).toHaveLength(1);
    expect(movements()[0]).toHaveAttribute("data-state", "release");
  });

  it("says no movement matched rather than that the mandate has none", async () => {
    await renderMandate(mandateDetailRead({ ledger: three() }), {
      q: "nothing-matches-this",
    });
    expect(
      document.querySelector('[data-state="filtered-empty"]')?.textContent,
    ).toContain("No movement matches");
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });

  it("keeps the tiles at the record's own figures while a search narrows the rows", async () => {
    await renderMandate(mandateDetailRead({ ledger: three() }), {
      q: "calls",
    });
    expect(movements()).toHaveLength(1);
    expect(screen.getByTestId("mandate-tiles").textContent).toContain(
      "$2,000.00",
    );
  });

  it("offers a later page only when one exists", async () => {
    await renderMandate(mandateDetailRead({ ledger: three() }));
    expect(document.querySelector('[data-page="older"]')).toBeNull();
    const many = Array.from({ length: 30 }, () => mandateMovement());
    cleanup();
    await renderMandate(mandateDetailRead({ ledger: many }));
    expect(movements()).toHaveLength(25);
    expect(
      document.querySelector('[data-page="older"]')?.getAttribute("href"),
    ).toContain("offset=25");
  });
});
