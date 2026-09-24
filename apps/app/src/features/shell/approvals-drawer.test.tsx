// @vitest-environment jsdom
// The approvals drawer (fleet.md "Approvals drawer", audit-prompt check 7),
// driven from the top bar the way an operator drives it: the organization-wide
// count on the button, the list under "N waiting on you" with live countdowns,
// today's resolutions, the full card behind a row with "All approvals" above
// it, and Escape, the close button and the scrim each closing it. A read that
// failed says so and makes the count partial; nothing is drawn as zero.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { MouseEvent, ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import en from "../../../messages/en.json";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";
import { approvalItem, shellData, shellWorkspace } from "./shell.builders";
import { ShellClient } from "./shell-client";
import type { ShellData } from "./shell-data";

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform",
  refresh: vi.fn(),
}));

// The command menu's search_tools read answers nothing here; shell-client.test.tsx covers it.
vi.mock("./command-actions", () => ({
  searchCommands: () => Promise.resolve({ ok: true, value: { rows: [] } }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      {...rest}
      onClick={(e) => {
        e.preventDefault(); // jsdom cannot navigate documents
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock("@oxagen/ui", () => ({
  OxagenWordmark: () => <svg aria-hidden="true" />,
}));

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  nav.pathname = "/acme/core-platform";
  nav.refresh.mockReset();
});

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function renderShell(data: ShellData, cards: Record<string, ReactNode> = {}) {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ ...en, ...shellMessages, ...uiMessages }}
    >
      <ShellClient data={data} cards={cards} />
      <main id="main" />
    </NextIntlClientProvider>,
  );
}

const soon = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function waiting(): ShellData {
  return shellData({
    approvals: {
      workspaces: [
        shellWorkspace({
          pending: readOk({
            items: [
              approvalItem({ expiresAt: soon(9) }),
              approvalItem({
                id: "apr_02K5RS8F3J",
                tool: "jira__delete_issue@1",
                agentKey: "acme.core.triage",
                expiresAt: soon(3),
              }),
            ],
            more: false,
          }),
          resolved: readOk({
            items: [
              {
                id: "apr_03K5RS8F3J",
                runId: null,
                tool: "salesforce__send_email@1",
                agentKey: "acme.core.support-bot",
                requester: null,
                rule: "mandate:mnd_7K2ETQ4:human_above:usd",
                createdAt: "2026-09-23T08:00:00Z",
                expiresAt: "2026-09-23T08:10:00Z",
                resolvedAt: "2026-09-23T08:02:00Z",
                resolution: "approved",
                resolvedBy: "user:usr_01K3F8QB7R",
                autoRuleRef: null,
              },
            ],
            more: false,
          }),
        }),
        shellWorkspace({
          slug: "finops",
          name: "FinOps",
          pending: readOk({
            items: [
              approvalItem({
                id: "apr_04K5RS8F3J",
                tool: "stripe__create_payment@4",
                agentKey: "acme.finops.invoice-bot",
                expiresAt: soon(5),
              }),
            ],
            more: false,
          }),
        }),
      ],
      truncated: false,
      readAt: Date.now(),
    },
  });
}

const cards = {
  apr_01K5RS8F3J: <section data-testid="card">the full card</section>,
};

function button() {
  return within(screen.getByRole("banner", { name: "Top bar" })).getByRole(
    "button",
    { name: /^Approvals/ },
  );
}

function drawer() {
  return document.getElementById("apdrawer") as HTMLElement;
}

describe("the approvals button", () => {
  it("counts every parked call across the organization's workspaces", () => {
    renderShell(waiting());
    expect(button()).toHaveAccessibleName("Approvals, 3 waiting");
    expect(button()).toHaveAttribute("aria-controls", "apdrawer");
    expect(button()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("approvals-count")).toHaveTextContent("3");
  });

  it("marks the count partial when a workspace's queue could not be read, and draws no zero for it (negative)", () => {
    renderShell(
      shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              pending: {
                ok: false,
                reason: "error",
                code: "run_index_unavailable",
                status: 503,
              },
            }),
            shellWorkspace({
              slug: "finops",
              name: "FinOps",
              pending: readOk({ items: [approvalItem()], more: false }),
            }),
          ],
          truncated: false,
          readAt: Date.now(),
        },
      }),
    );
    expect(button()).toHaveAccessibleName("Approvals, 1+ waiting");
  });

  it('carries a queue that ran past the read into the list\'s eyebrow and the Fleet count as "+"', async () => {
    const user = userEvent.setup();
    renderShell(
      shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              pending: readOk({
                items: [
                  approvalItem({ expiresAt: soon(9) }),
                  approvalItem({ id: "apr_02K5RS8F3J", expiresAt: soon(9) }),
                ],
                more: true,
              }),
            }),
          ],
          truncated: false,
          readAt: Date.now(),
        },
      }),
    );
    expect(button()).toHaveAccessibleName("Approvals, 2+ waiting");
    const fleet = document.querySelector('[data-count="fleet"]');
    expect(fleet).toHaveTextContent("2+");
    expect(fleet).toHaveTextContent(", 2+ waiting");
    await user.click(button());
    expect(drawer()).toHaveTextContent("2+ waiting on you");
  });

  it("draws no count and no figure when no queue could be read (negative)", () => {
    renderShell(
      shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              pending: {
                ok: false,
                reason: "denied",
                permission: "workspace.read",
              },
            }),
          ],
          truncated: false,
          readAt: Date.now(),
        },
      }),
    );
    expect(button()).toHaveAccessibleName("Approvals");
    expect(screen.queryByTestId("approvals-count")).toBeNull();
  });

  it("draws no count when nothing is parked", () => {
    renderShell(shellData());
    expect(button()).toHaveAccessibleName("Approvals, 0 waiting");
    expect(screen.queryByTestId("approvals-count")).toBeNull();
  });
});

describe("the drawer", () => {
  it("is inert and hidden until the button opens it", async () => {
    const user = userEvent.setup();
    renderShell(waiting(), cards);
    expect(drawer()).toHaveAttribute("inert");
    expect(drawer()).toHaveAttribute("aria-hidden", "true");
    await user.click(button());
    expect(drawer()).not.toHaveAttribute("inert");
    expect(button()).toHaveAttribute("aria-pressed", "true");
    const aside = screen.getByRole("complementary", { name: "Approvals" });
    expect(aside).toBe(drawer());
    expect(
      within(aside).getByRole("heading", { level: 3, name: "Approvals" }),
    ).toBeInTheDocument();
    expect(aside).toHaveTextContent("3 waiting");
    expect(
      within(aside).getByRole("button", { name: "Close approvals" }),
    ).toHaveFocus();
  });

  it("lists every parked call under the count, each with its agent, workspace and a live countdown", async () => {
    const user = userEvent.setup();
    renderShell(waiting(), cards);
    await user.click(button());
    const aside = drawer();
    expect(aside).toHaveTextContent("3 waiting on you");
    // `.eyebrow.q` is muted, and `.apd-row` has the plain hairline: no row is
    // tinted while nothing it records marks it critical (#3848).
    expect(within(aside).getByText("3 waiting on you")).toHaveClass(
      "text-muted-foreground",
    );
    // `.apd-btn[aria-pressed="true"]`: the open drawer's button takes the approval ink.
    expect(button()).toHaveAttribute("aria-pressed", "true");
    expect(button()).toHaveClass("border-info", "text-info");
    const rows = within(aside).getAllByTestId("approval-row");
    for (const r of rows) {
      expect(r).toHaveClass("border-border");
      expect(r).not.toHaveClass("border-info/40");
    }
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual([
      "github__create_release@2",
      "jira__delete_issue@1",
      "stripe__create_payment@4",
    ]);
    expect(rows[0]).toHaveTextContent("release-manager · Core platform");
    expect(rows[2]).toHaveTextContent("invoice-bot · FinOps");
    expect(rows[0]).toHaveAccessibleName("Open approval apr_01K5RS8F3J");
    expect(rows[1]?.querySelector("[data-countdown]")?.textContent).toMatch(
      /^[23]:\d{2}$/,
    );
    // What a parked call does not record is said once, and tied to its gap.
    expect(
      within(aside).getByTestId("approval-row-not-backed"),
    ).toHaveAttribute("data-gap");
    // Today's resolutions follow, with the decision as a dot and a word.
    expect(aside).toHaveTextContent("1 resolved today");
    expect(within(aside).getByTestId("resolved-row")).toHaveTextContent(
      "salesforce__send_email@1",
    );
    expect(within(aside).getByTestId("resolved-row")).toHaveTextContent(
      "approved",
    );
    expect(within(aside).getByTestId("resolved-row")).toHaveTextContent(
      "support-bot · Core platform",
    );
    // No interjection is recorded, and the list says so rather than implying none is open.
    expect(
      within(aside).getByTestId("interjection-not-backed"),
    ).toHaveTextContent("An open interjection has no record yet.");
    expect(
      within(aside).getByTestId("interjection-not-backed"),
    ).toHaveAttribute("data-gap");
    expect(aside).toHaveTextContent(
      "A resolution mints a single-use approval token bound to the call digest, the agent, the run, and an expiry.",
    );
  });

  it("shows the full card behind a row, and All approvals goes back to the list", async () => {
    const user = userEvent.setup();
    renderShell(waiting(), cards);
    await user.click(button());
    await user.click(
      within(drawer()).getByRole("button", {
        name: "Open approval apr_01K5RS8F3J",
      }),
    );
    expect(within(drawer()).getByTestId("card")).toHaveTextContent(
      "the full card",
    );
    expect(within(drawer()).queryAllByTestId("approval-row")).toEqual([]);
    await user.click(
      within(drawer()).getByRole("button", { name: "All approvals" }),
    );
    expect(within(drawer()).getAllByTestId("approval-row")).toHaveLength(3);
  });

  it("opens a resolved row onto its chain, resolution and resolver, with nothing left to decide", async () => {
    const user = userEvent.setup();
    renderShell(waiting(), cards);
    await user.click(button());
    await user.click(
      within(drawer()).getByRole("button", {
        name: "Open approval apr_03K5RS8F3J",
      }),
    );
    const card = within(drawer()).getByTestId("resolved-card");
    expect(card).toHaveTextContent("salesforce__send_email@1");
    expect(card).toHaveTextContent("Which agentacme.core.support-bot");
    expect(card).toHaveTextContent(
      "Which rulemandate:mnd_7K2ETQ4:human_above:usd",
    );
    expect(card).toHaveTextContent("Who askednot recorded");
    expect(card).toHaveTextContent("Resolutionapproved");
    expect(card).toHaveTextContent("Resolved byuser:usr_01K3F8QB7R");
    expect(card.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-09-23T08:02:00Z",
    );
    expect(
      within(card).queryByRole("button", { name: /Approve|Deny/ }),
    ).toBeNull();
    await user.click(
      within(drawer()).getByRole("button", { name: "All approvals" }),
    );
    expect(within(drawer()).getAllByTestId("resolved-row")).toHaveLength(1);
  });

  it("gives a countdown under two minutes the warning tone, and none above it", async () => {
    const user = userEvent.setup();
    renderShell(
      shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              pending: readOk({
                items: [
                  approvalItem({ id: "apr_05K5RS8F3J", expiresAt: soon(1) }),
                  approvalItem({ id: "apr_06K5RS8F3J", expiresAt: soon(9) }),
                ],
                more: false,
              }),
            }),
          ],
          truncated: false,
          readAt: Date.now(),
        },
      }),
    );
    await user.click(button());
    const soonest = drawer().querySelector('[data-countdown="apr_05K5RS8F3J"]');
    const later = drawer().querySelector('[data-countdown="apr_06K5RS8F3J"]');
    expect(soonest).toHaveAttribute("data-warn");
    expect(soonest).toHaveClass("text-critical");
    expect(later).not.toHaveAttribute("data-warn");
    expect(later).toHaveClass("text-info");
  });

  it("says a call is no longer listed when its card is gone (negative)", async () => {
    const user = userEvent.setup();
    renderShell(waiting(), {});
    await user.click(button());
    await user.click(
      within(drawer()).getByRole("button", {
        name: "Open approval apr_02K5RS8F3J",
      }),
    );
    expect(drawer()).toHaveTextContent("That approval is no longer listed.");
  });

  it("closes on Escape and gives focus back to the button", async () => {
    const user = userEvent.setup();
    renderShell(waiting(), cards);
    await user.click(button());
    await user.keyboard("{Escape}");
    expect(drawer()).toHaveAttribute("inert");
    expect(button()).toHaveFocus();
  });

  it("closes from the scrim and from its close button", async () => {
    const user = userEvent.setup();
    renderShell(waiting(), cards);
    await user.click(button());
    await user.click(screen.getByTestId("apdrawer-scrim"));
    expect(drawer()).toHaveAttribute("inert");
    await user.click(button());
    await user.click(
      within(drawer()).getByRole("button", { name: "Close approvals" }),
    );
    expect(drawer()).toHaveAttribute("inert");
  });

  it("opens when a page asks for it, as Fleet's waiting tile does", async () => {
    const { openApprovals } = await import("@/shared/approvals-drawer");
    renderShell(waiting(), cards);
    act(() => {
      openApprovals();
    });
    await waitFor(() => {
      expect(drawer()).not.toHaveAttribute("inert");
    });
  });

  it("says nothing is waiting when nothing is, and why a call would park", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(button());
    expect(drawer()).toHaveTextContent("Nothing is waiting on a human.");
    expect(drawer()).toHaveTextContent(
      "A call parks here when policy returns approve. Denials never park; they end the call and are free.",
    );
    expect(
      within(drawer()).queryByTestId("approval-row-not-backed"),
    ).toBeNull();
  });

  it("names a workspace whose queue it could not read, and a bound it stopped at (negative)", async () => {
    const user = userEvent.setup();
    renderShell(
      shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              pending: {
                ok: false,
                reason: "denied",
                permission: "workspace.read",
              },
            }),
          ],
          truncated: true,
          readAt: Date.now(),
        },
      }),
    );
    await user.click(button());
    expect(drawer().querySelector('[data-reason="denied"]')).not.toBeNull();
    expect(
      within(drawer()).getByTestId("apdrawer-truncated"),
    ).toHaveTextContent(
      "Oxagen read the first 1 workspaces of this organization.",
    );
  });
});

describe("countdown", () => {
  it("reads m:ss until the expiry and null once it has passed", async () => {
    const { countdown } = await import("./approvals-drawer");
    expect(countdown(9 * 60_000 + 12_000, 0)).toBe("9:12");
    expect(countdown(5_000, 0)).toBe("0:05");
    expect(countdown(0, 0)).toBeNull();
    expect(countdown(0, 1_000)).toBeNull();
  });
});
