// @vitest-environment jsdom
// The Tools tab's registry body on its own, with the reads it is handed: a
// page that did not load, a roster that did not load, a registry whose total
// is unknown, the category chips in the order and with the counts the page's
// versions carry, the chip that is pressed and what pressing it again does,
// the provider chips the roster draws and the links that keep each filter,
// the provider's icon in its row, and the empty page with and without a
// filter. The page suite
// (tools.test.tsx) walks the ideal state through the whole page. axe checks
// the state each test ends in (INV-26).
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

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  importTools: vi.fn(),
  registerServer: vi.fn(),
  removeProvider: vi.fn(),
  setToolClassification: vi.fn(),
}));

const { Registry } = await import("./registry");
const { mcpServerList, toolVersionPage } = await import("./tools.builders");
const { mcpServerListOutput, toolVersionListOutput } = await import(
  "@/test/tools-outputs"
);

const at = { org: "acme", ws: "core-platform" };
const TOOLS = "/acme/core-platform/tools";
const t = translator("tools.registry");

type VersionRow = ReturnType<typeof toolVersionListOutput>["items"][number];
type Page = ReturnType<typeof toolVersionPage>;

function nth<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no ${what}`);
  return item;
}
const stripe = (): VersionRow =>
  nth(toolVersionListOutput().items, 0, "Stripe version");
const github = (): VersionRow =>
  nth(toolVersionListOutput().items, 1, "GitHub version");

/** A classified version carrying exactly these consequence tags. */
function tagged(id: string, consequenceTags: string[]): VersionRow {
  const base = stripe();
  if (base.classification === null) throw new Error("fixture lost its class");
  return {
    ...base,
    id,
    toolId: id.replace("tlv", "tol"),
    classification: { ...base.classification, consequenceTags },
  };
}

type Props = {
  read?: Read<Page>;
  total?: Page | null;
  servers?: Read<ReturnType<typeof mcpServerList>>;
  category?: string | null;
  provider?: string | null;
  cursor?: string | null;
  canImport?: boolean;
};

function renderRegistry({
  read = readOk(toolVersionPage()),
  total = toolVersionPage(),
  servers = readOk(mcpServerList()),
  category = null,
  provider = null,
  cursor = null,
  canImport = true,
}: Props = {}) {
  return render(
    <IntlProvider>
      <Registry
        at={at}
        orgRole={canImport ? "owner" : "member"}
        names="labels"
        category={category}
        provider={provider}
        cursor={cursor}
        canImport={canImport}
        canClassify={canImport}
        read={read}
        total={total}
        servers={servers}
      />
    </IntlProvider>,
  );
}

const chips = () =>
  within(screen.getByRole("group", { name: t("categories") }));
function chip(category: string): HTMLElement {
  const node = document.querySelector(`[data-category="${category}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no chip ${category}`);
  return node;
}
const providerChips = () =>
  within(screen.getByRole("group", { name: t("providers") }));
function providerChip(id: string): HTMLElement {
  const node = document.querySelector(`[data-provider="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no provider chip ${id}`);
  return node;
}
const STRIPE = "mcs_01k5s1";
const GITHUB = "mcs_01k5s2";
const STRIPE_ICON = "https://stripe.example/icon.png";
/** The roster with Stripe's icon set and GitHub's left unset. */
const rosterWithIcon = () =>
  mcpServerList({
    servers: mcpServerListOutput().servers.map((server) =>
      server.publicId === STRIPE ? { ...server, iconUrl: STRIPE_ICON } : server,
    ),
  });
const facetNote = () =>
  document.querySelector('[data-state="facets-declared"]')?.textContent;

beforeEach(() => {
  for (const fn of Object.values(router)) fn.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Registry › not loaded", () => {
  it("names the page's outage in place of the table, with Try again on the registry", () => {
    renderRegistry({ read: readError("tool_registry_unavailable", 503) });
    const error = screen.getByTestId("tools-error");
    expect(error).toHaveTextContent("tool_registry_unavailable");
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", TOOLS);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("names each imported version's source when the roster did not load, and opens no provider", () => {
    renderRegistry({ servers: readError("tool_registry_unavailable", 503) });
    const row = screen.getByText("Create payment").closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("no Stripe row");
    // The Provider cell, the row's second: the source word stands in for the
    // provider the failed roster cannot name.
    expect(within(row).getAllByRole("cell")[1]).toHaveTextContent(
      t("declaredSource.mcp"),
    );
    expect(
      screen.queryByRole("button", { name: "Open Stripe" }),
    ).not.toBeInTheDocument();
  });
});

describe("Registry › rows", () => {
  it("names a version declared here by its source, with no provider to open", () => {
    renderRegistry({
      read: readOk(
        toolVersionPage({
          items: [
            {
              ...github(),
              source: "custom",
              serverId: null,
              capabilityId: "summarize_invoice",
            },
          ],
        }),
      ),
    });
    const row = screen.getByText("Get file contents").closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("no declared row");
    expect(within(row).getAllByRole("cell")[1]).toHaveTextContent(
      t("declaredSource.custom"),
    );
    expect(
      within(row).queryByRole("button", { name: /^Open / }),
    ).not.toBeInTheDocument();
  });
});

describe("Registry › counts", () => {
  it("counts only what is shown when the registry's total is unknown", () => {
    renderRegistry({ total: null });
    expect(screen.getByTestId("tools-shown")).toHaveTextContent(
      t("shown", { shown: "2" }),
    );
  });

  it("counts only what is shown while the unfiltered registry has a later page", () => {
    renderRegistry({ total: toolVersionPage({ nextCursor: "cur_2" }) });
    expect(screen.getByTestId("tools-shown")).toHaveTextContent("2 shown");
    expect(screen.getByTestId("tools-shown")).not.toHaveTextContent("of");
  });

  it("offers a reader who may not import no import control", () => {
    renderRegistry({ canImport: false });
    expect(screen.queryByTestId("tools-import-open")).not.toBeInTheDocument();
  });
});

describe("Registry › category chips", () => {
  it("draws a chip per tag the page carries, in tag order, each counted", () => {
    renderRegistry({
      read: readOk(
        toolVersionPage({
          items: [
            // First seen: destroys_data, moves_money, alters_production, an
            // order that is neither sorted nor reversed.
            tagged("tlv_01k5b1", ["destroys_data"]),
            tagged("tlv_01k5b2", ["moves_money", "destroys_data"]),
            tagged("tlv_01k5b3", ["alters_production", "moves_money"]),
            github(),
          ],
        }),
      ),
    });
    const tags = [...document.querySelectorAll("[data-category]")].map((node) =>
      node.getAttribute("data-category"),
    );
    expect(tags).toEqual([
      "all",
      "alters_production",
      "destroys_data",
      "moves_money",
    ]);
    expect(chip("alters_production")).toHaveTextContent("alters_production1");
    expect(chip("destroys_data")).toHaveTextContent("destroys_data2");
    expect(chip("moves_money")).toHaveTextContent("moves_money2");
    expect(chip("all")).toHaveTextContent(`${t("allCategories")}4`);
  });

  it("calls the all chip this page's while a later page exists, and says the tags are this page's", () => {
    renderRegistry({ read: readOk(toolVersionPage({ nextCursor: "cur_2" })) });
    expect(chip("all")).toHaveTextContent(t("allOnPage"));
    expect(facetNote()).toBe(t("categoriesNote"));
    expect(screen.getByTestId("tools-next-page")).toBeVisible();
  });

  it("presses the chip in effect, clears the filter when it is pressed again, and drops the all chip's count", () => {
    renderRegistry({
      category: "moves_money",
      read: readOk(toolVersionPage({ items: [stripe()] })),
    });
    const pressed = chip("moves_money");
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(chip("all")).toHaveAttribute("aria-pressed", "false");
    expect(chip("all")).toHaveTextContent(
      new RegExp(`^${t("allCategories")}$`),
    );
    expect(facetNote()).toBe(t("categoriesFilteredNote"));
    expect(chips().getAllByRole("button")).toHaveLength(2);
    fireEvent.click(pressed);
    expect(router.push).toHaveBeenCalledWith(TOOLS);
  });

  it("narrows to a tag when its chip is pressed", () => {
    renderRegistry();
    fireEvent.click(chip("moves_money"));
    expect(router.push).toHaveBeenCalledWith(`${TOOLS}?category=moves_money`);
  });
});

describe("Registry › empty", () => {
  it("says the registry holds nothing when no filter or page narrows it", () => {
    renderRegistry({ read: readOk(toolVersionPage({ items: [] })) });
    expect(screen.getByText(t("emptyRegistry"))).toHaveAttribute(
      "data-state",
      "empty",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it.each<[string, Props]>([
    ["a tag narrows it", { category: "changes_access" }],
    ["a later page is shown", { cursor: "cur_2" }],
  ])("says no version on the page carries the tag when %s", (_case, props) => {
    renderRegistry({ ...props, read: readOk(toolVersionPage({ items: [] })) });
    expect(screen.getByText(t("emptyCategory"))).toHaveAttribute(
      "data-state",
      "empty",
    );
    expect(screen.queryByText(t("emptyRegistry"))).not.toBeInTheDocument();
  });
});

describe("Registry › provider icon", () => {
  it("shows the provider's icon before its name, and its initial when it has none", () => {
    renderRegistry({ servers: readOk(rosterWithIcon()) });
    const stripeButton = screen.getByRole("button", { name: "Open Stripe" });
    expect(
      stripeButton.querySelector('[data-provider-icon="image"]'),
    ).toHaveAttribute("src", STRIPE_ICON);
    const githubButton = screen.getByRole("button", { name: "Open GitHub" });
    expect(
      githubButton.querySelector('[data-provider-icon="initial"]'),
    ).toHaveTextContent("G");
  });
});

describe("Registry › provider chips", () => {
  it("draws every provider on the roster, in roster order, each counted from the unfiltered registry", () => {
    renderRegistry({ servers: readOk(rosterWithIcon()) });
    const ids = [...document.querySelectorAll("[data-provider]")].map((node) =>
      node.getAttribute("data-provider"),
    );
    expect(ids).toEqual(["all", STRIPE, GITHUB]);
    expect(providerChip("all")).toHaveTextContent(
      new RegExp(`^${t("allProviders")}$`),
    );
    expect(providerChip(STRIPE)).toHaveTextContent(/Stripe1$/);
    expect(providerChip(GITHUB)).toHaveTextContent(/GitHub1$/);
    expect(
      providerChip(STRIPE).querySelector('[data-provider-icon="image"]'),
    ).toHaveAttribute("src", STRIPE_ICON);
    expect(providerChip("all")).toHaveAttribute("aria-pressed", "true");
  });

  it("offers a provider whose versions are all on a later page, and counts none while the total is unknown", () => {
    // The page shows Stripe's version alone; GitHub is still offered, because
    // the chips come from the roster, not from the rows.
    renderRegistry({
      read: readOk(toolVersionPage({ items: [stripe()] })),
      total: toolVersionPage({ nextCursor: "cur_2" }),
    });
    expect(providerChip(GITHUB)).toHaveTextContent(/GitHub$/);
    expect(providerChip(STRIPE)).toHaveTextContent(/Stripe$/);
  });

  it("narrows to a provider when its chip is pressed, keeping the tag and starting at page one", () => {
    renderRegistry({ category: "moves_money", cursor: "cur_2" });
    fireEvent.click(providerChip(GITHUB));
    expect(router.push).toHaveBeenCalledWith(
      `${TOOLS}?category=moves_money&provider=${GITHUB}`,
    );
  });

  it("presses the provider in effect, and pressing it or All providers clears only that filter", () => {
    renderRegistry({
      category: "moves_money",
      provider: STRIPE,
      read: readOk(toolVersionPage({ items: [stripe()] })),
    });
    expect(providerChip(STRIPE)).toHaveAttribute("aria-pressed", "true");
    expect(providerChip("all")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(providerChip(STRIPE));
    expect(router.push).toHaveBeenLastCalledWith(
      `${TOOLS}?category=moves_money`,
    );
    fireEvent.click(providerChip("all"));
    expect(router.push).toHaveBeenLastCalledWith(
      `${TOOLS}?category=moves_money`,
    );
  });

  it("keeps the provider on the tag chips, the names toggle, and the next page", () => {
    renderRegistry({
      provider: STRIPE,
      read: readOk(toolVersionPage({ items: [stripe()], nextCursor: "cur_2" })),
    });
    fireEvent.click(chip("moves_money"));
    expect(router.push).toHaveBeenLastCalledWith(
      `${TOOLS}?category=moves_money&provider=${STRIPE}`,
    );
    fireEvent.click(chip("all"));
    expect(router.push).toHaveBeenLastCalledWith(`${TOOLS}?provider=${STRIPE}`);
    fireEvent.click(screen.getByRole("button", { name: "API names" }));
    expect(router.push).toHaveBeenLastCalledWith(
      `${TOOLS}?provider=${STRIPE}&names=api`,
    );
    expect(screen.getByTestId("tools-next-page")).toHaveAttribute(
      "href",
      `${TOOLS}?provider=${STRIPE}&cursor=cur_2`,
    );
  });

  it("draws no provider chips when the roster did not load", () => {
    renderRegistry({ servers: readError("tool_registry_unavailable", 503) });
    expect(
      screen.queryByRole("group", { name: t("providers") }),
    ).not.toBeInTheDocument();
  });

  it("keeps the chip that clears a provider filter when the roster did not load", () => {
    renderRegistry({
      provider: STRIPE,
      servers: readError("tool_registry_unavailable", 503),
    });
    expect(providerChips().getAllByRole("button")).toHaveLength(1);
    fireEvent.click(providerChip("all"));
    expect(router.push).toHaveBeenCalledWith(TOOLS);
  });
});

describe("Registry › empty by provider", () => {
  it("says the provider supplied nothing when a provider narrows it", () => {
    renderRegistry({
      provider: STRIPE,
      read: readOk(toolVersionPage({ items: [] })),
    });
    expect(screen.getByText(t("emptyProvider"))).toHaveAttribute(
      "data-state",
      "empty",
    );
  });

  it("says the provider has no version with the tag when both narrow it", () => {
    renderRegistry({
      provider: STRIPE,
      category: "changes_access",
      read: readOk(toolVersionPage({ items: [] })),
    });
    expect(screen.getByText(t("emptyProviderCategory"))).toHaveAttribute(
      "data-state",
      "empty",
    );
  });
});
