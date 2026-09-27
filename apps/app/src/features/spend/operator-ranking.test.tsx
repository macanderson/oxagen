// @vitest-environment jsdom
// The operator ranking (D15): a manager sees the operators by unproductive
// spend, the operator rows and the row for runs with no operator add up to the
// total, every figure links to its definition, and each operator's runs link
// to their Cost tab. Anyone else sees who can read it. With pseudonyms on, the
// pseudonym replaces the name and the figures that could match it to a name
// are hidden. A period in two currencies says why no ranking was built.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorRanking } from "@/data/contracts/spend";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  canReadOperatorRanking,
  OperatorRankingSection,
} from "./operator-ranking";

const action = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
vi.mock("./operator-ranking-actions", () => ({
  setOperatorPseudonymsAction: action,
}));

const AT = { org: "acme", ws: "core-platform" };

const usd = (micros: string) => ({ micros, currency: "USD" });

const MARCUS = {
  id: "prn_marcusbell",
  name: "Marcus Bell",
  email: "marcus@acme.test",
  avatarUrl: null,
  role: "workspace.owner",
};

/** $10.00 in all: Marcus $6.00, Ada $3.00, runs with no operator $1.00. */
const RANKING: OperatorRanking = {
  period: { from: "2026-09-01", to: "2026-09-15" },
  pseudonyms: false,
  unproductive: usd("10000000"),
  unattributed: { unproductive: usd("1000000"), runs: 1 },
  operators: [
    {
      rank: 1,
      operator: { kind: "named", key: "prn_marcusbell", facts: MARCUS },
      unproductive: usd("6000000"),
      shareOfTotal: 0.6,
      unproductiveShare: 0.25,
      runs: 2,
      topRuns: [
        { runId: "arun_01", unproductive: usd("4000000") },
        { runId: "arun_02", unproductive: usd("2000000") },
      ],
    },
    {
      rank: 2,
      operator: { kind: "named", key: "prn_ada", facts: null },
      unproductive: usd("3000000"),
      shareOfTotal: 0.3,
      unproductiveShare: null,
      runs: 1,
      topRuns: [{ runId: "arun_03", unproductive: usd("3000000") }],
    },
  ],
};

const PSEUDONYMS: OperatorRanking = {
  ...RANKING,
  pseudonyms: true,
  operators: [
    {
      rank: 1,
      operator: { kind: "pseudonym", pseudonym: "Operator 0A1B2C3D" },
      unproductive: usd("6000000"),
      shareOfTotal: 0.6,
      unproductiveShare: null,
      runs: null,
      topRuns: [],
    },
    {
      rank: 2,
      operator: { kind: "pseudonym", pseudonym: "Operator 4E5F6A7B" },
      unproductive: usd("3000000"),
      shareOfTotal: 0.3,
      unproductiveShare: null,
      runs: null,
      topRuns: [],
    },
  ],
};

beforeEach(() => {
  action.mockReset();
  refresh.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function show(ranking: Parameters<typeof OperatorRankingSection>[0]["ranking"]) {
  return render(
    <IntlProvider>
      <OperatorRankingSection ranking={ranking} at={AT} />
    </IntlProvider>,
  );
}

function rowAt(rank: number): HTMLElement {
  const hit = document.querySelector<HTMLElement>(`tr[data-rank="${rank}"]`);
  if (hit === null) throw new Error(`no row ${rank}`);
  return hit;
}

function rowNamed(name: "unattributed" | "total"): HTMLElement {
  const hit = document.querySelector<HTMLElement>(`tr[data-row="${name}"]`);
  if (hit === null) throw new Error(`no row ${name}`);
  return hit;
}

/** Dollars in a cell's first money figure, as micros. */
function microsIn(row: HTMLElement): bigint {
  const money = row.querySelector("[data-testid=money]");
  if (money === null) throw new Error("no money in row");
  const dollars = (money.textContent ?? "").replace(/[^0-9.]/g, "");
  const [whole = "0", cents = "0"] = dollars.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(cents.padEnd(2, "0")) * 10_000n;
}

describe("canReadOperatorRanking", () => {
  it("admits an org Owner or Admin and nobody else", () => {
    expect(canReadOperatorRanking({ orgRole: "owner" })).toBe(true);
    expect(canReadOperatorRanking({ orgRole: "admin" })).toBe(true);
    expect(canReadOperatorRanking({ orgRole: "member" })).toBe(false);
    expect(canReadOperatorRanking({ orgRole: "billing" })).toBe(false);
  });
});

describe("Operator ranking", () => {
  it("ranks the operators by unproductive spend with the design's columns", () => {
    show(readOk(RANKING));
    const table = screen.getByRole("table", { name: "Operator ranking" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Rank",
      "Operator",
      "Unproductive spend",
      "Share of total",
      "Unproductive share",
      "Runs",
      "Runs behind",
    ]);
    const marcus = rowAt(1);
    expect(
      within(marcus).getByRole("link", { name: "Marcus Bell" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/operator/prn_marcusbell",
    );
    expect(marcus).toHaveTextContent("$6.00");
    expect(marcus).toHaveTextContent("60%");
    expect(marcus).toHaveTextContent("25%");
    const ada = rowAt(2);
    expect(ada).toHaveTextContent("Unnamed operator");
    // Ada's priced spend was not read: her share is not recorded, not 0%.
    expect(ada.querySelector('[data-recorded="false"]')).not.toBeNull();
  });

  it("adds the operator rows and the runs with no operator up to the total", () => {
    show(readOk(RANKING));
    const parts =
      microsIn(rowAt(1)) + microsIn(rowAt(2)) + microsIn(rowNamed("unattributed"));
    expect(parts).toBe(microsIn(rowNamed("total")));
    expect(rowNamed("total")).toHaveTextContent("$10.00");
    expect(rowNamed("unattributed")).toHaveTextContent("Runs with no operator");
    expect(rowNamed("unattributed")).toHaveTextContent("10%");
  });

  it("links every figure to its definition", () => {
    show(readOk(RANKING));
    const marcus = rowAt(1);
    const targets = [...marcus.querySelectorAll("a[href^='#']")].map((a) =>
      a.getAttribute("href"),
    );
    expect(targets).toEqual([
      "#spend-ranking-def-unproductive",
      "#spend-ranking-def-shareOfTotal",
      "#spend-ranking-def-unproductiveShare",
      "#spend-ranking-def-runs",
    ]);
    for (const target of targets) {
      const definition = document.getElementById((target ?? "").slice(1));
      expect(definition).not.toBeNull();
      expect(definition?.textContent).not.toBe("");
    }
    expect(
      within(rowNamed("total")).getByRole("link", { name: "$10.00" }),
    ).toHaveAttribute("href", "#spend-ranking-def-unproductive");
  });

  it("links the runs behind each figure to their Cost tab", async () => {
    show(readOk(RANKING));
    const marcus = rowAt(1);
    await userEvent.click(within(marcus).getByText("2 runs"));
    expect(
      within(marcus).getByRole("link", { name: "arun_01" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_01?tab=cost");
    expect(
      within(marcus).getByRole("link", { name: "arun_02" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_02?tab=cost");
  });

  it("gives no verdict on the person", () => {
    show(readOk(RANKING));
    const panel = screen
      .getByRole("heading", { name: "Operator ranking" })
      .closest("section");
    expect(panel).not.toBeNull();
    expect(panel?.textContent ?? "").not.toMatch(
      /\b(worst|best|poor|bad|good|underperform|waste|wasted|session|trace)\b/i,
    );
  });

  it("shows who can read the ranking to anyone else, and no figure (negative)", () => {
    show(null);
    expect(
      screen.getByRole("heading", { name: "Operator ranking" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/An org Owner or Admin can read the operator ranking/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByTestId("money")).toBeNull();
    expect(screen.queryByTestId("operator-pseudonyms")).toBeNull();
  });

  it("passes the handler's refusal through as the section's denied state (negative)", () => {
    show({
      ok: false,
      reason: "denied",
      permission: "get_operator_ranking",
    });
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector("[data-state=denied]")).not.toBeNull();
  });

  it("says why no ranking was built for a period in two currencies (negative)", () => {
    show(readError("ranking_mixed_currency", 409));
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByText(/more than one currency/),
    ).toBeInTheDocument();
  });

  it("says so when no run has unproductive spend", () => {
    show(
      readOk({
        ...RANKING,
        unproductive: usd("0"),
        unattributed: { unproductive: usd("0"), runs: 0 },
        operators: [],
      }),
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByText("No run has unproductive spend in this period."),
    ).toBeInTheDocument();
  });
});

describe("Operator ranking › pseudonyms", () => {
  it("shows the pseudonym and hides the figures that could match it to a name", () => {
    show(readOk(PSEUDONYMS));
    const first = rowAt(1);
    expect(first).toHaveTextContent("Operator 0A1B2C3D");
    expect(within(first).queryByRole("link", { name: /Marcus/ })).toBeNull();
    expect(first).toHaveTextContent("$6.00");
    expect(first).toHaveTextContent("60%");
    expect(first.querySelectorAll('[data-hidden="true"]')).toHaveLength(3);
    expect(first.querySelector("a[href*='/runs/']")).toBeNull();
    expect(screen.getByText(/Pseudonyms are on\./)).toBeInTheDocument();
    expect(screen.getByText(/Pseudonyms on\./)).toBeInTheDocument();
  });

  it("keeps the ranks and the totals under pseudonyms", () => {
    show(readOk(PSEUDONYMS));
    const parts =
      microsIn(rowAt(1)) + microsIn(rowAt(2)) + microsIn(rowNamed("unattributed"));
    expect(parts).toBe(microsIn(rowNamed("total")));
  });

  it("turns pseudonyms on and reads the page again", async () => {
    action.mockResolvedValue({ ok: true, value: { pseudonyms: true } });
    show(readOk(RANKING));
    expect(screen.getByText(/Pseudonyms off\./)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on pseudonyms" }),
    );
    expect(action).toHaveBeenCalledWith(AT, true);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("turns pseudonyms off", async () => {
    action.mockResolvedValue({ ok: true, value: { pseudonyms: false } });
    show(readOk(PSEUDONYMS));
    await userEvent.click(
      screen.getByRole("button", { name: "Turn off pseudonyms" }),
    );
    expect(action).toHaveBeenCalledWith(AT, false);
  });

  it("says who can change the setting when the handler refuses (negative)", async () => {
    action.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    show(readOk(RANKING));
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on pseudonyms" }),
    );
    expect(
      await screen.findByText(
        "Only an org Owner or Admin can change this setting.",
      ),
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
