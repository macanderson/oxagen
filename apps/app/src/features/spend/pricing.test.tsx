// @vitest-environment jsdom
// The Pricing tab in each of its states: the models the book cannot price, the
// book itself, the tab with one of its two reads down, and the tab with
// nothing unpriced. A rate prints as money per million units, never as the
// micros the contract carried; a model with no price prints as unpriced, never
// as $0.00 (INV-09). Axe checks the state each test ends in (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceBook, UnpricedModels } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import spend from "../../../messages/spend.json";
import ui from "../../../messages/ui.json";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
const setPriceEntryAction = vi.fn();
const removePriceEntryAction = vi.fn();
vi.mock("./actions", () => ({
  setBudgetAction: vi.fn(),
  exportStatementAction: vi.fn(),
  recordFindingFixAction: vi.fn(),
  dismissFindingAction: vi.fn(),
  setPriceEntryAction,
  removePriceEntryAction,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Spend } = await import("./spend");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "billing",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const TODAY = new Date("2026-09-15T12:00:00.000Z");
const AT = "2026-09-15T12:00:00.000Z";

const priceBook = vi.fn<DataSource["spend"]["priceBook"]>();
const unpricedModels = vi.fn<DataSource["spend"]["unpricedModels"]>();
const source: DataSource = {
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: { context: vi.fn(), preferences: vi.fn() },
  billing: {
    plan: vi.fn(),
    usageCredits: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: {
    list: vi.fn(),
    get: vi.fn(),
    frameBody: vi.fn(),
    cost: vi.fn(),
    transcript: vi.fn(),
    chain: vi.fn(),
    outputs: vi.fn(),
  },
  approvals: { pending: vi.fn(), resolved: vi.fn() },
  agents: {
    list: vi.fn(),
    get: vi.fn(),
    toolbelt: vi.fn(),
    incidents: vi.fn(),
  },
  spend: {
    byGroup: vi.fn(),
    fleet: vi.fn(),
    drill: vi.fn(),
    waste: vi.fn(),
    budgets: vi.fn(),
    gatewayPolicy: vi.fn(),
    findings: vi.fn(),
    findingEvidence: vi.fn(),
    priceBook,
    unpricedModels,
  },
  onboarding: { state: vi.fn(), firstFrame: vi.fn() },
  org: {
    members: vi.fn(),
    roles: vi.fn(),
    workspaces: vi.fn(),
    apiKeys: vi.fn(),
    costCenters: vi.fn(),
    modelCredential: vi.fn(),
    sso: vi.fn(),
  },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: { events: vi.fn(), exportEvents: vi.fn() },
  skills: { inventory: vi.fn(), configuration: vi.fn() },
  steering: {
    records: vi.fn(),
    record: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
    hub: vi.fn(),
    deliveries: vi.fn(),
  },
  tools: {
    versions: vi.fn(),
    grants: vi.fn(),
    killSwitches: vi.fn(),
    approvalRules: vi.fn(),
    connections: vi.fn(),
    mcpServers: vi.fn(),
  },
};

const entry = (
  over: Partial<PriceBook["entries"][number]> = {},
): PriceBook["entries"][number] => ({
  provider: "anthropic",
  model: "claude-sonnet-5",
  modelAliases: [],
  region: null,
  tokenClass: "output",
  unit: "token",
  ratePerMillion: { micros: "3000000", currency: "USD" },
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  source: "list",
  negotiated: false,
  ...over,
});

const model = (
  over: Partial<UnpricedModels["models"][number]> = {},
): UnpricedModels["models"][number] => ({
  model: "acme-internal-7b",
  provider: "acme",
  calls: 1240,
  tokens: 9_400_000,
  firstSeen: "2026-08-20T00:00:00.000Z",
  lastSeen: "2026-09-15T00:00:00.000Z",
  missingClasses: ["input_uncached", "output"],
  fullyUnpriced: true,
  ...over,
});

const book = (entries: PriceBook["entries"]): Read<PriceBook> =>
  readOk({ at: AT, entries });

const unpriced = (models: UnpricedModels["models"]): Read<UnpricedModels> =>
  readOk({ since: "2026-08-16T00:00:00.000Z", at: AT, models });

async function renderPricing() {
  const element = await Spend({
    ctx,
    source,
    searchParams: { tab: "pricing" },
    today: TODAY,
  });
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ ...spend, ...ui }}
      timeZone="UTC"
    >
      {element}
    </NextIntlClientProvider>,
  );
}

function rowOf(table: HTMLElement, name: string): HTMLElement {
  const found = table.querySelector<HTMLElement>(`tr[data-model="${name}"]`);
  if (found === null) throw new Error(`no row ${name}`);
  return found;
}

function panelOf(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `section[aria-labelledby="${id}"]`,
  );
  if (found === null) throw new Error(`no panel ${id}`);
  return found;
}

beforeEach(() => {
  priceBook.mockReset();
  unpricedModels.mockReset();
  setPriceEntryAction.mockReset();
  removePriceEntryAction.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Pricing › Models the book cannot price", () => {
  it("names the model, its vendor, what it has run and the classes with no price", async () => {
    priceBook.mockResolvedValue(book([entry()]));
    unpricedModels.mockResolvedValue(unpriced([model()]));
    await renderPricing();

    expect(priceBook).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(unpricedModels).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const row = rowOf(panelOf("spend-unpriced"), "acme-internal-7b");
    expect(row).toHaveTextContent("acme");
    expect(within(row).getByText("1,240")).toBeInTheDocument();
    expect(within(row).getByText("9,400,000")).toBeInTheDocument();
    expect(within(row).getByText("Input")).toBeInTheDocument();
    expect(within(row).getByText("Output")).toBeInTheDocument();
  });

  it("never prints an unpriced model as a zero price", async () => {
    priceBook.mockResolvedValue(book([]));
    unpricedModels.mockResolvedValue(unpriced([model()]));
    await renderPricing();
    const row = rowOf(panelOf("spend-unpriced"), "acme-internal-7b");
    expect(row).not.toHaveTextContent("$0.00");
    expect(row.querySelector("[data-testid=money]")).toBeNull();
    expect(within(row).getByText("No cost at all")).toBeInTheDocument();
  });

  it("tells a model with no cost at all apart from one the rollup could only estimate", async () => {
    priceBook.mockResolvedValue(book([]));
    unpricedModels.mockResolvedValue(
      unpriced([
        model(),
        model({
          model: "acme-internal-70b",
          missingClasses: ["cache_read"],
          fullyUnpriced: false,
        }),
      ]),
    );
    const panel = await renderPricing().then(() => panelOf("spend-unpriced"));

    const serious = rowOf(panel, "acme-internal-7b");
    expect(serious).toHaveAttribute("data-fully-unpriced", "true");
    expect(within(serious).getByText("No cost at all")).toBeInTheDocument();
    const partial = rowOf(panel, "acme-internal-70b");
    expect(partial).toHaveAttribute("data-fully-unpriced", "false");
    expect(within(partial).getByText("Estimated")).toBeInTheDocument();
  });

  it("says a vendor the frames did not record rather than leaving the cell blank", async () => {
    priceBook.mockResolvedValue(book([]));
    unpricedModels.mockResolvedValue(unpriced([model({ provider: null })]));
    await renderPricing();
    expect(
      within(rowOf(panelOf("spend-unpriced"), "acme-internal-7b")).getByText(
        "vendor not recorded",
      ),
    ).toBeInTheDocument();
  });

  it("draws no box at all when every model this workspace has run is priced", async () => {
    priceBook.mockResolvedValue(book([entry()]));
    unpricedModels.mockResolvedValue(unpriced([]));
    await renderPricing();
    expect(screen.getByTestId("unpriced-none")).toHaveTextContent(
      "Every model this workspace has run since",
    );
    expect(
      document.querySelector('section[aria-labelledby="spend-unpriced"]'),
    ).toBeNull();
  });

  it("opens the rate dialog on the model the row names, so nothing is retyped", async () => {
    priceBook.mockResolvedValue(book([]));
    unpricedModels.mockResolvedValue(unpriced([model()]));
    await renderPricing();
    await userEvent.click(
      within(rowOf(panelOf("spend-unpriced"), "acme-internal-7b")).getByRole(
        "button",
        { name: "Set a rate" },
      ),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Set a negotiated rate",
    });
    expect(within(dialog).getByLabelText("Model")).toHaveValue(
      "acme-internal-7b",
    );
    expect(within(dialog).getByLabelText("Vendor")).toHaveValue("acme");
    // Only the classes this model is missing are asked for; the rest are a
    // click away.
    expect(within(dialog).getByLabelText("Input")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Output")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Reasoning")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Show every token class" }),
    );
    expect(within(dialog).getByLabelText("Reasoning")).toBeInTheDocument();
  });
});

describe("Pricing › The price book", () => {
  it("groups scheduled rates and cancels the selected entry", async () => {
    const id = "9f1b7a2c-0000-4000-8000-000000000001";
    priceBook.mockResolvedValue(
      book([
        entry(),
        entry({
          cancellationToken: id,
          model: "future-model",
          negotiated: true,
          source: "negotiated",
          effectiveFrom: "2026-12-01T00:00:00.000Z",
        }),
      ]),
    );
    unpricedModels.mockResolvedValue(unpriced([]));
    removePriceEntryAction.mockResolvedValue({
      ok: true,
      value: { fallbackPriced: true },
    });
    await renderPricing();
    const group = screen.getByRole("region", {
      name: "Scheduled negotiated rates",
    });
    expect(group).toHaveTextContent("future-model");
    const user = userEvent.setup();
    await user.click(within(group).getByTestId("spend-remove-rate-open"));
    const dialog = await screen.findByTestId("spend-remove-rate-dialog");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Cancel scheduled rate",
      }),
    );
    expect(removePriceEntryAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cancellationToken: id }),
    );
  });

  it("renders at most 100 catalog rows and permits reading the next page", async () => {
    priceBook.mockResolvedValue(
      book(
        Array.from({ length: 101 }, (_, index) =>
          entry({ model: `model-${String(index).padStart(3, "0")}` }),
        ),
      ),
    );
    unpricedModels.mockResolvedValue(unpriced([]));
    await renderPricing();
    expect(
      panelOf("spend-price-book").querySelectorAll("tbody tr"),
    ).toHaveLength(100);
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    expect(
      panelOf("spend-price-book").querySelectorAll("tbody tr"),
    ).toHaveLength(1);
    expect(panelOf("spend-price-book")).toHaveTextContent("model-100");
  });

  it("tells this organization's negotiated rows from the platform's list prices", async () => {
    priceBook.mockResolvedValue(
      book([
        entry(),
        entry({
          tokenClass: "input_uncached",
          ratePerMillion: { micros: "2400000", currency: "USD" },
          source: "negotiated",
          negotiated: true,
          effectiveFrom: "2026-09-01T00:00:00.000Z",
        }),
      ]),
    );
    unpricedModels.mockResolvedValue(unpriced([]));
    await renderPricing();

    const panel = panelOf("spend-price-book");
    const rows = panel.querySelectorAll("tbody tr");
    // Typed by the query rather than asserted at each use: `querySelectorAll`
    // over a generic selector yields `Element`, and `within()` wants an
    // `HTMLElement`, which the repo's lint forbids reaching by assertion.
    const [negotiated, listed] = [...rows].filter(
      (row): row is HTMLElement => row instanceof HTMLElement,
    );
    if (negotiated === undefined || listed === undefined)
      throw new Error("expected two price-book rows");
    // The organization's own row reads before the list row it beats.
    expect(negotiated).toHaveAttribute("data-negotiated", "true");
    expect(negotiated).toHaveTextContent("Your negotiated rate");
    expect(listed).toHaveAttribute("data-negotiated", "false");
    expect(listed).toHaveTextContent("List price");
    expect(
      within(negotiated).getByRole("button", {
        name: "Remove the negotiated rate for claude-sonnet-5, Input",
      }),
    ).toBeInTheDocument();
    expect(within(listed).queryByRole("button")).toBeNull();
    expect(listed).toHaveTextContent("The platform sets this one");
  });

  it("prints the rate as money for a million units, not as the micros it was carried in", async () => {
    priceBook.mockResolvedValue(
      book([
        entry({ ratePerMillion: { micros: "2400000", currency: "USD" } }),
        entry({
          tokenClass: "cache_read",
          ratePerMillion: { micros: "30", currency: "USD" },
        }),
        entry({
          tokenClass: "server_tool_request",
          unit: "request",
          ratePerMillion: { micros: "10000000", currency: "USD" },
        }),
      ]),
    );
    unpricedModels.mockResolvedValue(unpriced([]));
    await renderPricing();

    const panel = panelOf("spend-price-book");
    const rate = (tokenClass: string) => {
      const row = panel.querySelector<HTMLElement>(
        `tr[data-class="${tokenClass}"]`,
      );
      if (row === null) throw new Error(`no row ${tokenClass}`);
      return row;
    };
    expect(rate("output")).toHaveTextContent("$2.40");
    expect(rate("output")).toHaveTextContent("per 1M tokens");
    // A rate far below a cent is printed as measured, never rounded to $0.00.
    expect(rate("cache_read")).toHaveTextContent("$0.00003");
    expect(rate("cache_read")).not.toHaveTextContent("$0.00 ");
    expect(rate("server_tool_request")).toHaveTextContent("per 1M requests");
  });

  it("reads a model's classes together and names each one in words", async () => {
    priceBook.mockResolvedValue(
      book([
        entry({ provider: "openai", model: "gpt-5", tokenClass: "output" }),
        entry({ tokenClass: "cache_write_1h" }),
        entry({ tokenClass: "input_uncached" }),
      ]),
    );
    unpricedModels.mockResolvedValue(unpriced([]));
    await renderPricing();
    const rows = [
      ...panelOf("spend-price-book").querySelectorAll("tbody tr"),
    ].map(
      (row) =>
        `${row.getAttribute("data-model") ?? ""}/${row.getAttribute("data-class") ?? ""}`,
    );
    expect(rows).toEqual([
      "claude-sonnet-5/input_uncached",
      "claude-sonnet-5/cache_write_1h",
      "gpt-5/output",
    ]);
    expect(panelOf("spend-price-book")).toHaveTextContent(
      "Cache write, 1 hour",
    );
  });

  it("says when a row stopped applying, and that an open row still does", async () => {
    priceBook.mockResolvedValue(
      book([
        entry(),
        entry({
          tokenClass: "input_uncached",
          effectiveTo: "2026-09-10T00:00:00.000Z",
        }),
      ]),
    );
    unpricedModels.mockResolvedValue(unpriced([]));
    await renderPricing();
    const panel = panelOf("spend-price-book");
    expect(panel).toHaveTextContent("still in effect");
    expect(panel).toHaveTextContent("until Sep 10, 2026");
  });

  it("says the book is empty rather than drawing an empty table", async () => {
    priceBook.mockResolvedValue(book([]));
    unpricedModels.mockResolvedValue(unpriced([]));
    await renderPricing();
    expect(
      screen.getByText(
        "The price book holds nothing yet. Until it does, no run in this organization can be priced.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Pricing › one read down", () => {
  it("still shows the book when the unpriced read fails (negative)", async () => {
    priceBook.mockResolvedValue(book([entry()]));
    unpricedModels.mockResolvedValue(
      readError("rollup_rebuild_in_progress", 504),
    );
    await renderPricing();
    expect(
      screen.getByRole("heading", { name: "Spend could not be loaded" }),
    ).toBeInTheDocument();
    expect(panelOf("spend-price-book")).toHaveTextContent("List price");
  });

  it("keeps the way to state a rate open when the book read is down (negative)", async () => {
    priceBook.mockResolvedValue(readError("rollup_rebuild_in_progress", 504));
    unpricedModels.mockResolvedValue(unpriced([model()]));
    await renderPricing();
    expect(
      screen.getByRole("button", { name: "Set a negotiated rate" }),
    ).toBeInTheDocument();
  });

  it("still shows the unpriced models when the book read is refused (negative)", async () => {
    priceBook.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    unpricedModels.mockResolvedValue(unpriced([model()]));
    await renderPricing();
    expect(
      screen.getByRole("heading", {
        name: "You cannot see this workspace’s spend",
      }),
    ).toBeInTheDocument();
    expect(panelOf("spend-unpriced")).toHaveTextContent("acme-internal-7b");
  });

  it("renders both refusals rather than blanking the tab (negative)", async () => {
    priceBook.mockResolvedValue(readError("rollup_rebuild_in_progress", 504));
    unpricedModels.mockResolvedValue(
      readError("rollup_rebuild_in_progress", 504),
    );
    await renderPricing();
    expect(
      screen.getAllByRole("heading", { name: "Spend could not be loaded" }),
    ).toHaveLength(2);
  });
});
