// @vitest-environment jsdom
// The Kill switches tab body on its own, with the board it is handed: a board
// that did not load, a scoped switch for each kind a card can be headed by
// (a sibling workspace, an operator, an agent, a connection), the newest row
// of a target flipped twice, and the actor a card names for a flip and for a
// clear. The page suite (tools.test.tsx) walks the shipped cards through the
// whole page; this suite covers what the board can hold beyond them. axe
// checks the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { router, flipKillSwitch } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  flipKillSwitch: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ flipKillSwitch }));

const { Switches } = await import("./switches");
const { killSwitchBoard } = await import("./tools.builders");
const { killSwitchListOutput } = await import("@/test/tools-outputs");

const at = { org: "acme", ws: "core-platform" };
const SELF_WS = "7b000000-0000-4000-8000-000000000001";
const SIBLING_WS = "7b000000-0000-4000-8000-000000000002";
const PRIYA = "usr_priyashah0000000000000";
const DEV = "usr_devnoname0000000000000";
const t = translator("tools.switches");

type Row = ReturnType<typeof killSwitchListOutput>["switches"][number];
type Board = ReturnType<typeof killSwitchBoard>;

const MEMBERS = [
  { id: PRIYA, name: "Priya Shah", email: "priya@acme.example" },
  { id: DEV, name: null, email: "dev@acme.example" },
];
const AGENTS = [
  { id: "agt_invoicebot", slug: "invoice-bot", name: "Invoice bot" },
];

/** One switch row as `list_kill_switches` returns it, flipped on by Priya. */
function row(id: string, target: Row["target"], over: Partial<Row> = {}): Row {
  return {
    id,
    target,
    scope: "workspace",
    on: true,
    reason: "Incident 42.",
    flippedBy: PRIYA,
    flippedAt: "2026-09-11T15:02:00.000Z",
    clearedAt: null,
    clearedBy: null,
    ...over,
  };
}

const board = (switches: Row[]) => readOk(killSwitchBoard({ switches }));

function renderSwitches(
  read: Read<Board>,
  { canFlip = true }: { canFlip?: boolean } = {},
) {
  return render(
    <IntlProvider>
      <Switches
        at={at}
        orgRole={canFlip ? "owner" : "member"}
        canFlip={canFlip}
        selfWorkspaceId={SELF_WS}
        orgName="Acme Robotics"
        wsName="Core platform"
        members={MEMBERS}
        agents={AGENTS}
        read={read}
      />
    </IntlProvider>,
  );
}

function card(id: string) {
  const node = document.querySelector(`[data-switch="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no card ${id}`);
  return node;
}
const heading = (id: string) => within(card(id)).getByRole("heading");
function fact(id: string, name: string) {
  const node = card(id).querySelector(`[data-fact="${name}"] dd`);
  if (!(node instanceof HTMLElement)) throw new Error(`no ${name} on ${id}`);
  return node;
}

beforeEach(() => {
  flipKillSwitch.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Switches › not loaded", () => {
  it("names the permission a reader was refused the board on, and draws no card", () => {
    renderSwitches({ ok: false, reason: "denied", permission: "tools.read" });
    expect(screen.getByTestId("tools-denied")).toHaveTextContent("tools.read");
    expect(document.querySelector("[data-switch]")).toBeNull();
  });

  it("names the board's outage with its code, and offers Try again on this tab", () => {
    renderSwitches(readError("tool_registry_unavailable", 503));
    const error = screen.getByTestId("tools-error");
    expect(error).toHaveTextContent("tool_registry_unavailable");
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/acme/core-platform/tools/switches");
  });
});

describe("Switches › scoped cards", () => {
  it("heads a sibling workspace's switch by its id, since the board carries nothing else to name it by", () => {
    renderSwitches(
      board([
        row(
          "emd_01k5w2",
          { kind: "workspace", id: SIBLING_WS },
          { scope: "org" },
        ),
      ]),
    );
    expect(heading("emd_01k5w2")).toHaveTextContent(SIBLING_WS);
    // This workspace's own card still ships, allowing, and is not this one.
    expect(card("workspace:self")).toHaveAttribute("data-on", "false");
  });

  it("heads an operator switch by the member's name, by their email when they have none, and by the id when they left", () => {
    renderSwitches(
      board([
        row("emd_01k5o1", { kind: "operator", id: PRIYA }),
        row("emd_01k5o2", { kind: "operator", id: DEV }),
        row("emd_01k5o3", {
          kind: "operator",
          id: "usr_gone000000000000000000",
        }),
      ]),
    );
    expect(heading("emd_01k5o1")).toHaveTextContent("Priya Shah");
    expect(heading("emd_01k5o2")).toHaveTextContent("dev@acme.example");
    expect(heading("emd_01k5o3")).toHaveTextContent(
      "usr_gone000000000000000000",
    );
    expect(
      within(card("emd_01k5o1")).getByText(t("kinds.operator")),
    ).toBeVisible();
  });

  it("heads an agent switch by the agent's slug, and by its id when it is not a live agent here", () => {
    renderSwitches(
      board([
        row("emd_01k5a1", { kind: "agent", id: "agt_invoicebot" }),
        row("emd_01k5a2", { kind: "agent", id: "agt_retired" }),
      ]),
    );
    expect(heading("emd_01k5a1")).toHaveTextContent("invoice-bot");
    expect(heading("emd_01k5a2")).toHaveTextContent("agt_retired");
  });

  it("heads a connection switch by its id and says the flip also revoked its grants", () => {
    renderSwitches(
      board([row("emd_01k5n1", { kind: "connection", id: "mcrd_01k5c9" })]),
    );
    expect(heading("emd_01k5n1")).toHaveTextContent("mcrd_01k5c9");
    expect(fact("emd_01k5n1", "blastRadius")).toHaveTextContent(
      t("blastRadius.connection"),
    );
    expect(fact("emd_01k5n1", "takesEffect")).toHaveTextContent(
      t("takesEffect", { generation: 4 }),
    );
  });

  it("puts a class switch on another tag with the class cards, carrying Edit and Remove", () => {
    renderSwitches(
      board([
        row(
          "emd_01k5d1",
          { kind: "class", id: "destroys_data" },
          { scope: "org" },
        ),
      ]),
    );
    const classes = within(
      screen.getByRole("region", { name: t("classHeading") }),
    );
    expect(classes.getByText("every destroys_data tool")).toBeVisible();
    expect(fact("emd_01k5d1", "takesEffect")).toHaveTextContent(
      t("takesEffect", { generation: 12 }),
    );
    expect(
      screen.getByTestId("tools-switch-edit-emd_01k5d1-open"),
    ).toBeVisible();
    expect(
      screen.getByTestId("tools-switch-remove-emd_01k5d1-open"),
    ).toBeVisible();
  });
});

describe("Switches › a card's record", () => {
  it.each<[string, boolean]>([
    ["newest first", true],
    ["oldest first", false],
  ])(
    "shows the newest flip of a target flipped twice, listed %s",
    (_order, newestFirst) => {
      const newer = row(
        "emd_01k5t2",
        { kind: "tool_server", id: "mcs_01k5s1" },
        {
          on: false,
          flippedAt: "2026-09-12T09:00:00.000Z",
          clearedAt: "2026-09-12T10:00:00.000Z",
          clearedBy: PRIYA,
        },
      );
      const older = row("emd_01k5t1", {
        kind: "tool_server",
        id: "mcs_01k5s1",
      });
      renderSwitches(board(newestFirst ? [newer, older] : [older, newer]));
      expect(card("emd_01k5t2")).toHaveAttribute("data-on", "false");
      expect(document.querySelector('[data-switch="emd_01k5t1"]')).toBeNull();
    },
  );

  it("names who flipped and who cleared by the roster, and says so when the record holds no one", () => {
    renderSwitches(
      board([
        row(
          "emd_01k5v1",
          { kind: "tool_version", id: "tlv_01k5a1" },
          {
            on: false,
            flippedBy: DEV,
            clearedAt: "2026-09-12T10:00:00.000Z",
            clearedBy: null,
          },
        ),
        row(
          "emd_01k5v2",
          { kind: "tool_version", id: "tlv_01k5a2" },
          { flippedBy: "usr_gone000000000000000000" },
        ),
      ]),
    );
    expect(fact("emd_01k5v1", "flippedBy")).toHaveTextContent(
      "dev@acme.example",
    );
    expect(fact("emd_01k5v1", "clearedAt")).toHaveTextContent(
      t("flippedByUnrecorded"),
    );
    // A flipper no longer on the roster is printed as the id the record holds.
    expect(fact("emd_01k5v2", "flippedBy")).toHaveTextContent(
      "usr_gone000000000000000000",
    );
    expect(
      card("emd_01k5v2").querySelector('[data-fact="clearedAt"]'),
    ).toBeNull();
  });

  it("names the flipper by name when the roster has one", () => {
    renderSwitches(
      board([row("emd_01k5v3", { kind: "tool_version", id: "tlv_01k5a3" })]),
    );
    expect(fact("emd_01k5v3", "flippedBy")).toHaveTextContent("Priya Shah");
  });
});

describe("Switches › Create a switch", () => {
  it("offers the workspace's agents and the org's members as targets, a member without a name by email", async () => {
    renderSwitches(board([]));
    fireEvent.click(screen.getByTestId("tools-switch-new-open"));
    await screen.findByTestId("tools-switch-new");
    const target = document.querySelector("#switch-target");
    if (!(target instanceof HTMLElement)) throw new Error("no target picker");
    expect(
      [...target.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(
      expect.arrayContaining(["invoice-bot", "Priya Shah", "dev@acme.example"]),
    );
  });

  it("is not offered to a reader who may not flip, who reads each scoped switch's state as a word", () => {
    renderSwitches(
      board([row("emd_01k5a1", { kind: "agent", id: "agt_invoicebot" })]),
      { canFlip: false },
    );
    expect(
      screen.queryByTestId("tools-switch-new-open"),
    ).not.toBeInTheDocument();
    expect(within(card("emd_01k5a1")).getByText(t("denying"))).toHaveAttribute(
      "data-state",
      "denying",
    );
    expect(
      screen.queryByTestId("tools-switch-edit-emd_01k5a1-open"),
    ).not.toBeInTheDocument();
  });
});
