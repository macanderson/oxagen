// @vitest-environment jsdom
// The mandate page over a fake DataSource, state by state as the design draws
// them (the design's `pMandate`): loaded, never drawn on, loading, error and
// access denied, each with an axe check (INV-26). The two writes are proven in
// actions.test.ts and their dialogs in mandate-actions.test.tsx; this suite is
// about what the page renders and what it refuses to claim.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "@/data/contracts/agents";
import type { OrgRole } from "@/data/contracts/common";
import type { MemberList } from "@/data/contracts/org";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  callsAuthority,
  mandateAuthority,
  mandateDetailRead,
  mandateDraw,
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

const members: MemberList = {
  members: [
    {
      id: "usr_priyanatarajan",
      name: "Priya Natarajan",
      email: "priya@example.com",
      role: "billing",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  invitations: [],
};

const agent = {
  identity: {
    id: "agt_invoicebot",
    slug: "invoice-bot",
    name: "Invoice bot",
    description: null,
    agentKey: "a-intel.finops.invoice-bot",
    harness: "claude-code",
    principalId: null,
    operatorId: null,
    status: "active",
    registeredAt: "2026-09-01T00:00:00.000Z",
    firstFrameAt: null,
    costCenter: null,
  },
  credentials: [],
  roles: [],
  hosts: [],
  definition: null,
} as unknown as AgentDetail;

type DetailRead = Parameters<typeof mandateSource>[0];
type Names = Parameters<typeof mandateSource>[1];

async function renderMandate(
  read: DetailRead,
  options: {
    mandate?: string;
    as?: OrgRole;
    agent?: string | null;
    names?: Names;
    viewerName?: string | null;
  } = {},
) {
  const { source, calls } = mandateSource(
    read,
    options.names ?? { members: readOk(members), agent: readOk(agent) },
  );
  const element = await Mandate({
    ctx: options.as === undefined ? ctx : viewer(options.as),
    source,
    mandate: options.mandate ?? "mnd_4f2a9c",
    agent: options.agent ?? null,
    viewerName: options.viewerName ?? null,
  });
  const view = render(<IntlProvider>{element}</IntlProvider>);
  return { calls, ...view };
}

const draws = () => screen.getAllByTestId("ledger-draw");
const tile = (id: string) => screen.getByTestId(id);

// `cleanup()` runs whether or not the axe check passes, so one violation does
// not leave markup behind for every test after it.
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

  it("names the page Mandate and the mandate by its id in the mono face", async () => {
    await renderMandate(mandateDetailRead());
    expect(screen.getByText("Mandate")).toBeInTheDocument();
    const h1 = screen.getByRole("heading", { level: 1, name: "mnd_4f2a9c" });
    expect(h1.className).toContain("font-mono");
  });

  it("badges the status as a dot and a word, the granter by name, and the currency", async () => {
    await renderMandate(mandateDetailRead());
    expect(screen.getByText("active")).toHaveAttribute("data-status", "active");
    expect(screen.getByText("granted by Priya Natarajan")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(
      screen.getByText("monthly infrastructure invoices, PO-4471"),
    ).toBeInTheDocument();
  });

  it("names the granter by principal id when the member list cannot be read", async () => {
    await renderMandate(mandateDetailRead(), {
      names: { members: readError("denied", 403) },
    });
    expect(
      screen.getByText("granted by usr_priyanatarajan"),
    ).toBeInTheDocument();
  });

  it("offers Change limits and Revoke, in that order, and no gold action", async () => {
    await renderMandate(mandateDetailRead());
    const actions = screen.getByRole("group", { name: "Mandate actions" });
    const buttons = within(actions).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Change limits",
      "Revoke",
    ]);
    // Gold is identity: the body of this page carries none.
    for (const button of screen.getAllByRole("button"))
      expect(button.className).not.toContain("bg-button-primary-bg");
  });

  it("draws four tiles, each one figure and the design's basis line", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          authority: [mandateAuthority(), callsAuthority()],
        }),
      }),
    );
    expect(tile("tile-per-call")).toHaveTextContent("Per call");
    expect(tile("tile-per-call")).toHaveTextContent("$250.00");
    expect(tile("tile-per-call")).toHaveTextContent(
      "read from the call by its declared path",
    );
    expect(tile("tile-per-period")).toHaveTextContent("$2,000.00");
    expect(tile("tile-per-period")).toHaveTextContent(
      "monthly with 50 calls per day",
    );
    expect(tile("tile-settled")).toHaveTextContent("$1,204.18");
    expect(tile("tile-settled")).toHaveTextContent(
      "this period, from the ledger",
    );
    expect(tile("tile-remaining")).toHaveTextContent("$615.82");
    expect(tile("tile-remaining")).toHaveTextContent(
      "after $180.00 reserved at decision time",
    );
  });

  it("draws the remaining-authority bar as an image that states all three figures", async () => {
    await renderMandate(mandateDetailRead());
    const bar = screen.getByTestId("authority-bar");
    expect(within(bar).getByText("Remaining authority")).toBeInTheDocument();
    expect(within(bar).getByText("of $2,000.00 USD")).toBeInTheDocument();
    expect(within(bar).getByRole("img")).toHaveAccessibleName(
      "$1,204.18 settled, $180.00 reserved by calls in flight, $615.82 remaining of $2,000.00",
    );
    expect(within(bar).getByText("settled $1,204.18")).toBeInTheDocument();
    expect(within(bar).getByText("(60.2%)")).toBeInTheDocument();
    expect(within(bar).getByText("(9%)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Two concurrent calls cannot both fit under the same remaining limit: the reservation is taken before dispatch.",
      ),
    ).toBeInTheDocument();
  });

  it("draws the reservation only while one is held", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          authority: [
            mandateAuthority({
              reserved: {
                kind: "money",
                money: { micros: "0", currency: "USD" },
              },
              reservedRatio: 0,
            }),
          ],
        }),
      }),
    );
    const bar = screen.getByTestId("authority-bar");
    expect(bar.querySelector('[data-part="reserved"]')).toBeNull();
    expect(within(bar).getByRole("img")).toHaveAccessibleName(
      "$1,204.18 settled, $615.82 remaining of $2,000.00",
    );
  });

  it("says the reservation is held by this call when one call holds it", async () => {
    await renderMandate(
      mandateDetailRead({
        draws: [
          mandateDraw({ state: "reserve", externalEffectRef: null }),
          mandateDraw(),
        ],
      }),
    );
    const bar = screen.getByTestId("authority-bar");
    expect(
      within(bar).getByText("reserved by this call $180.00"),
    ).toBeInTheDocument();
    expect(within(bar).getByRole("img")).toHaveAccessibleName(
      "$1,204.18 settled, $180.00 reserved by this call, $615.82 remaining of $2,000.00",
    );
  });

  it("counts the calls that hold a reservation, and claims no count past the read bound", async () => {
    const open = [
      mandateDraw({ state: "reserve", externalEffectRef: null }),
      mandateDraw({ state: "reserve", externalEffectRef: null }),
    ];
    await renderMandate(mandateDetailRead({ draws: open }));
    expect(
      within(screen.getByTestId("authority-bar")).getByText(
        "reserved by 2 calls in flight $180.00",
      ),
    ).toBeInTheDocument();
    cleanup();
    await renderMandate(mandateDetailRead({ draws: open, readBound: 500 }));
    expect(
      within(screen.getByTestId("authority-bar")).getByText(
        "reserved by calls in flight $180.00",
      ),
    ).toBeInTheDocument();
  });

  it("lays the ledger out with the design's six columns and a receipt cell that says it is not recorded", async () => {
    await renderMandate(mandateDetailRead());
    const table = screen.getByRole("table", { name: "Draws on this mandate" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["When", "Call", "Amount", "State", "External id", "Receipt"]);
    const [row] = draws();
    expect(row).toHaveTextContent("2026-09-04");
    expect(row).toHaveTextContent("pi_3QaL8f2Xk");
    expect(row).toHaveTextContent("settled");
    const cells = row?.querySelectorAll("td") ?? [];
    // The Call cell names what is missing (#3871), never the measure or a uuid.
    expect(cells[1]).toHaveTextContent("tool version not recorded");
    expect(
      cells[1]?.querySelector('[data-state="not-backed"]'),
    ).toHaveAttribute("data-gap", "tool-version");
    expect(
      cells[5]?.querySelector('[data-state="not-backed"]'),
    ).toHaveAttribute("data-gap", "G8");
  });

  it("shows one row per call in the state it reached, with the time for today's draw", async () => {
    await renderMandate(
      mandateDetailRead({
        draws: [
          mandateDraw({
            state: "reserve",
            externalEffectRef: null,
            at: "2026-09-16T09:31:08.000Z",
          }),
        ],
      }),
    );
    const [row] = draws();
    expect(row).toHaveAttribute("data-state", "reserve");
    expect(row).toHaveTextContent("09:31:08");
    // A reservation has no receipt yet: the design's dash, named for a reader.
    const receipt = row?.querySelector('[data-state="no-receipt-yet"]');
    expect(receipt).toHaveTextContent("—No receipt yet");
  });

  it("marks a draw counted in an earlier period, which the Settled tile leaves out", async () => {
    await renderMandate(
      mandateDetailRead({
        draws: [mandateDraw(), mandateDraw({ periodKey: "2026-08" })],
      }),
    );
    const [current, earlier] = draws();
    expect(current?.querySelector('[data-state="earlier-period"]')).toBeNull();
    expect(
      earlier?.querySelector('[data-state="earlier-period"]'),
    ).toHaveTextContent("counted in 2026-08");
  });

  it("names the measure on a draw that is not the one the tiles speak for", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          authority: [mandateAuthority(), callsAuthority()],
        }),
        draws: [
          mandateDraw({
            state: "reserve",
            measure: "calls",
            value: { kind: "count", count: "1", unit: "calls" },
            externalEffectRef: null,
            periodKey: "2026-09-16",
          }),
        ],
      }),
    );
    expect(draws()[0]?.querySelectorAll("td")[2]).toHaveTextContent("calls");
  });

  it("says a reservation has no effect yet and a release has none, rather than a blank", async () => {
    await renderMandate(
      mandateDetailRead({
        draws: [
          mandateDraw({ state: "reserve", externalEffectRef: null }),
          mandateDraw({ state: "release", externalEffectRef: null }),
        ],
      }),
    );
    const [reserve, release] = draws();
    expect(reserve).toHaveTextContent("no effect yet");
    expect(release).toHaveTextContent("released, no effect");
  });

  it("searches, facets on State, and pages the ledger with a range line", async () => {
    const user = userEvent.setup({ delay: null });
    const ledger = Array.from({ length: 12 }, (_, index) =>
      mandateDraw({
        externalEffectRef: `pi_${String(index).padStart(2, "0")}`,
        state: index % 3 === 0 ? "reserve" : "settle",
      }),
    );
    await renderMandate(mandateDetailRead({ draws: ledger }));
    expect(draws()).toHaveLength(10);
    expect(screen.getByTestId("ledger-range")).toHaveTextContent("1–10 of 12");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(draws()).toHaveLength(2);
    expect(screen.getByTestId("ledger-range")).toHaveTextContent("11–12 of 12");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "State" }),
      "reserve",
    );
    expect(draws()).toHaveLength(4);
    await user.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "pi_03",
    );
    expect(draws()).toHaveLength(1);
    await user.clear(
      screen.getByRole("searchbox", { name: "Search this list" }),
    );
    await user.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "nothing",
    );
    expect(screen.getByText("No draw matches this search")).toBeInTheDocument();
  });

  it("sorts on the four headers whose cells carry a recorded value, ascending, descending, then back", async () => {
    const user = userEvent.setup({ delay: null });
    const usd = (micros: string) =>
      ({ kind: "money", money: { micros, currency: "USD" } }) as const;
    const ledger = [
      mandateDraw({ value: usd("30000000"), externalEffectRef: "pi_b" }),
      mandateDraw({ value: usd("10000000"), externalEffectRef: "pi_c" }),
      mandateDraw({ value: usd("20000000"), externalEffectRef: "pi_a" }),
    ];
    await renderMandate(mandateDetailRead({ draws: ledger }));
    const table = screen.getByRole("table", { name: "Draws on this mandate" });
    const sorts = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.getAttribute("aria-sort"));
    // Call and Receipt print what is not recorded, so they do not sort.
    expect(sorts).toEqual(["none", null, "none", "none", "none", null]);
    const refs = () =>
      draws().map((row) => row.querySelectorAll("td")[4]?.textContent);
    expect(refs()).toEqual(["pi_b", "pi_c", "pi_a"]);
    const amount = within(table).getByRole("button", { name: "Amount" });
    await user.click(amount);
    expect(refs()).toEqual(["pi_c", "pi_a", "pi_b"]);
    expect(amount.closest("th")).toHaveAttribute("aria-sort", "ascending");
    await user.click(amount);
    expect(refs()).toEqual(["pi_b", "pi_a", "pi_c"]);
    expect(amount.closest("th")).toHaveAttribute("aria-sort", "descending");
    await user.click(amount);
    expect(refs()).toEqual(["pi_b", "pi_c", "pi_a"]);
    await user.click(
      within(table).getByRole("button", { name: "External id" }),
    );
    expect(refs()).toEqual(["pi_a", "pi_b", "pi_c"]);
  });

  it("offers 5, 10, 25, 50 and All rows", async () => {
    const user = userEvent.setup({ delay: null });
    const ledger = Array.from({ length: 7 }, () => mandateDraw());
    await renderMandate(mandateDetailRead({ draws: ledger }));
    const rows = screen.getByRole("combobox", { name: "Rows" });
    expect(
      within(rows)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["5", "10", "25", "50", "All"]);
    await user.selectOptions(rows, "5");
    expect(draws()).toHaveLength(5);
    await user.selectOptions(rows, "0");
    expect(draws()).toHaveLength(7);
  });

  it("states the read bound above the table when the answer filled it", async () => {
    await renderMandate(mandateDetailRead({ readBound: 500 }));
    expect(screen.getByText(/newest 500 ledger movements/)).toBeInTheDocument();
  });

  it("fills the grant panel in the design's order, with the agent card and the granter's role at grant", async () => {
    await renderMandate(mandateDetailRead());
    const grant = screen.getByTestId("mandate-grant");
    expect(
      within(grant).getByRole("heading", { name: "Grant" }),
    ).toBeInTheDocument();
    expect(
      [...grant.querySelectorAll("dt")].map((dt) => dt.textContent),
    ).toEqual([
      "Agent",
      "Granted by",
      "Second approver",
      "Effect",
      "Counterparties",
      "Tools",
      "Approval",
      "Valid",
    ]);
    expect(
      within(grant).getByText("a-intel.finops.invoice-bot"),
    ).toBeInTheDocument();
    // The harness from get_agent; that read answers no runs or spend.
    expect(grant).toHaveTextContent(
      "Claude Code · runs and spend not read here",
    );
    expect(within(grant).getByTestId("valid-window")).toHaveTextContent(
      "2026-09-01 → 2026-12-30",
    );
    expect(within(grant).getByTestId("granted-by")).toHaveTextContent(
      "Priya Natarajan · Billing at grant",
    );
    expect(grant).toHaveTextContent("allow vendor:aws, vendor:githubdeny *");
    expect(grant).toHaveTextContent(
      "above $100.00, always for moves_money, approvers role:Billing",
    );
  });

  it("prints the tool patterns on one line, joined as the design joins them", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          tools: [
            "stripe__create_payment@*",
            "aws_billing__purchase_savings_plan@2",
          ],
        }),
      }),
    );
    expect(
      within(screen.getByTestId("mandate-grant")).getByText(
        "stripe__create_payment@*, aws_billing__purchase_savings_plan@2",
      ),
    ).toBeInTheDocument();
  });

  it("says a mandate stores no second approver rather than naming one", async () => {
    await renderMandate(mandateDetailRead());
    const grant = screen.getByTestId("mandate-grant");
    expect(
      within(grant).getByText(
        "Not recorded. A mandate stores no second approver yet.",
      ),
    ).toHaveAttribute("data-state", "not-backed");
  });

  it("says the approval rule parks nothing when it sets no threshold and no tag", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          approval: { humanAbove: [], alwaysHumanFor: [], approvers: [] },
        }),
      }),
    );
    expect(
      screen.getByText("no call on this mandate waits for a person"),
    ).toBeInTheDocument();
  });

  it("reads an empty allow list as any target, never as none", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({
          targets: [{ measure: "amount", allow: [], deny: [] }],
        }),
      }),
    );
    expect(screen.getByTestId("mandate-grant")).toHaveTextContent(
      "allow any targetdeny no pattern",
    );
  });

  it("declines to claim the ledger reconciles, and names the gap", async () => {
    await renderMandate(mandateDetailRead());
    const panel = screen.getByTestId("mandate-exceptions");
    expect(
      within(panel).getByRole("heading", { name: "Ledger" }),
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-state="not-backed"]')).toHaveAttribute(
      "data-gap",
      "G8",
    );
    expect(panel).not.toHaveTextContent(/Nothing is outstanding/);
  });

  it("offers Decline on a draft and nothing on a revoked mandate", async () => {
    await renderMandate(
      mandateDetailRead({
        mandate: mandateRow({ status: "draft", grantedBy: null }),
      }),
    );
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Change limits" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("not granted")).toBeInTheDocument();
    cleanup();
    await renderMandate(
      mandateDetailRead({ mandate: mandateRow({ status: "revoked" }) }),
    );
    expect(
      screen.queryByRole("group", { name: "Mandate actions" }),
    ).not.toBeInTheDocument();
  });
});

describe("Mandate › routes", () => {
  it("answers a URL that could never name a mandate with a 404", async () => {
    await expect(
      renderMandate(mandateDetailRead(), { mandate: "not-a-mandate" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("answers a mandate this workspace has not recorded with a 404", async () => {
    await expect(
      renderMandate(readError("mandate_not_found", 404)),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders on the design's route when the agent segment matches the record", async () => {
    await renderMandate(mandateDetailRead(), { agent: "invoice-bot" });
    expect(
      screen.getByRole("heading", { level: 1, name: "mnd_4f2a9c" }),
    ).toBeInTheDocument();
  });

  it("answers an agent segment the record contradicts with a 404", async () => {
    await expect(
      renderMandate(mandateDetailRead(), { agent: "someone-else" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("Mandate › empty", () => {
  it("replaces the page body with the design's state and no actions", async () => {
    await renderMandate(mandateDetailRead({ draws: [] }));
    const empty = screen.getByTestId("mandate-empty");
    expect(
      within(empty).getByRole("heading", {
        level: 1,
        name: "This mandate has never been drawn on",
      }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "It is active and its ledger is empty. Remaining authority equals the full period limit.",
    );
    // The state is the body: no header, no tiles, no table, no action.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mandate-tiles")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not call an undrawn limit authority on a mandate that is not in effect", async () => {
    await renderMandate(
      mandateDetailRead({
        draws: [],
        mandate: mandateRow({ status: "expired" }),
      }),
    );
    expect(screen.getByTestId("mandate-empty")).toHaveTextContent(
      "This mandate is not in effect now, so its undrawn limit authorizes nothing.",
    );
    // Not the design's "it is active" state, so the header stays.
    expect(
      screen.getByRole("heading", { level: 1, name: "mnd_4f2a9c" }),
    ).toBeInTheDocument();
  });
});

describe("Mandate › loading", () => {
  it("draws four tile blocks and a panel of seven rows, with no figure", () => {
    render(
      <IntlProvider>
        <MandateLoading />
      </IntlProvider>,
    );
    const skeleton = screen.getByRole("status", {
      name: "Loading this mandate",
    });
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton).toHaveTextContent("");
    expect(skeleton.querySelectorAll(".h-8")).toHaveLength(7);
  });
});

describe("Mandate › error", () => {
  it("names the code the control plane answered, and offers Try again and Open an incident", async () => {
    const user = userEvent.setup({ delay: null });
    await renderMandate(readError("mandate_ledger_unavailable", 503));
    const error = screen.getByTestId("mandate-error");
    expect(
      within(error).getByRole("heading", {
        name: "This mandate could not be loaded",
      }),
    ).toBeInTheDocument();
    expect(error).toHaveTextContent(
      "The control plane answered 503 mandate_ledger_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/a-intel/core-platform/mandates/mnd_4f2a9c");
    expect(screen.getByTestId("mandate-trace")).toHaveTextContent(
      /Trace not recorded\. Read at /,
    );
    await user.click(
      within(error).getByRole("button", { name: "Open an incident" }),
    );
    const dialog = await screen.findByTestId("open-incident");
    expect(dialog).toHaveTextContent(/does not record incidents/);
    expect(dialog.querySelector('[data-state="not-backed"]')).not.toBeNull();
  });

  it("points Try again at the design's route when that is the route it came from", async () => {
    await renderMandate(readError("mandate_ledger_unavailable", 503), {
      agent: "invoice-bot",
    });
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/a-intel/core-platform/agents/invoice-bot/mandates/mnd_4f2a9c",
    );
  });
});

describe("Mandate › access denied", () => {
  it("names the permission, offers Request access and Back to Fleet, and says who decided", async () => {
    const user = userEvent.setup({ delay: null });
    await renderMandate(
      { ok: false, reason: "denied", permission: "org.billing" },
      { as: "member", viewerName: "Marcus Bell" },
    );
    const denied = screen.getByTestId("mandate-denied");
    expect(
      within(denied).getByRole("heading", {
        name: "You cannot see this mandate",
      }),
    ).toBeInTheDocument();
    expect(denied).toHaveTextContent(
      "Your roles on Anderson Intelligence Corp. do not include org.billing",
    );
    expect(denied).toHaveTextContent(
      "An organization owner can grant it. The grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/a-intel/core-platform");
    expect(
      [...denied.querySelectorAll("dt")].map((dt) => dt.textContent),
    ).toEqual(["Signed in as", "Needed", "Decided by"]);
    expect(within(denied).getByTestId("signed-in-as")).toHaveTextContent(
      "Marcus Bell · workspace.member · core-platform",
    );
    // The refusal carries no deciding policy (#3841, #3846), so the line
    // says so before the rule that holds either way.
    expect(denied).toHaveTextContent(
      "Decided bypolicy not recorded · deny wins over every allow",
    );
    expect(
      denied.querySelector('[data-gap="deciding-policy"]'),
    ).toHaveTextContent("policy not recorded");
    // The header goes with the body: a refused reader is not told the id.
    expect(screen.queryByText("mnd_4f2a9c")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "You cannot see this mandate",
    );
    await user.click(
      within(denied).getByRole("button", { name: "Request access" }),
    );
    const dialog = await screen.findByTestId("request-access");
    expect(dialog).toHaveTextContent(/does not record access requests/);
    // The design's header close, with the footer's dismiss named Cancel.
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
  });

  it("says an access request is waiting when the read parked for approval", async () => {
    await renderMandate({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "arq_01",
    });
    expect(screen.getByTestId("mandate-pending")).toHaveTextContent("arq_01");
  });
});
