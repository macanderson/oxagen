// @vitest-environment jsdom
// The Tools tab of a Studio server page (#4678), drawn from the Studio
// fixtures: the table and its import checkboxes, the state each row takes as
// the draft changes, the classification a row shows, the three filters,
// search and paging, the definition budget in each of its states, the off
// controls the server draws, and the tool panel as far as the tab opens it,
// closes it and hands it the draft. The panel's own sections have their own
// suite (tool-panel.test.tsx). The draft lives in sessionStorage, so a test
// seeds it before the render and reads it back after a click. axe checks the
// state each test ends in (INV-26). A test that opens the panel closes it
// before it ends, so axe checks the tab and not the dialog.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { type DraftOp, parseStoredDraft } from "./draft";
import type { StudioServerView, StudioTool } from "./model";
import {
  BILLING,
  draftKey,
  fakeDraft,
  GITHUB,
  idDraftKey,
  offSwitch,
  SCRATCH,
  seedDraft,
  STRIPE,
  STUDIO_AT,
  stripeRecord,
  studioBoard,
  studioTool,
  studioView,
  WAREHOUSE,
  warehouseTool,
} from "./studio.builders";
import { ToolsTab } from "./tools-tab";

// No child reads the router today. The mock keeps a later one from reaching
// the real App Router, which does not exist in jsdom.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    window.sessionStorage.clear();
  }
});

type TabProps = ComponentProps<typeof ToolsTab>;

/**
 * The words the tests look for, from messages/mcp-studio.json: `offNone` and
 * `draftNotBuilt` from `mcpStudio.panel`, the rest from `mcpStudio.tools`.
 */
const COPY = {
  readOnly:
    "Only an organization owner or admin can import tools or change their classification.",
  refused:
    "The draft cannot hold that edit, so it was not kept. Remove an edit on the Changes tab or discard the draft first.",
  missing:
    "Discovery has not listed this server's tools yet. The table shows the tools the registry holds.",
  noMatch: "No tool matches these filters.",
  emptyBody: "The server listed no tools the last time Oxagen read it.",
  budgetMissing:
    "The definition budget is set in tools.toml, and Oxagen has not read this server's tools.toml yet.",
  unmeasured:
    "The budget is 8,000 tokens. Some imported tools have no measured definition, so the total is not known.",
  offNone:
    "The registry holds no version of this tool, so it has no switch to turn off.",
  draftNotBuilt:
    "Draft is not available yet. You can write the description yourself.",
} as const;

const COLUMNS = [
  "Tool",
  "State",
  "Risk",
  "Side effect",
  "Definition tokens",
  "Kill switch",
];

/** The most edits a draft holds: DraftShape in draft.ts, which exports no constant. */
const DRAFT_LIMIT = 2000;

/** The off controls the server draws, as the page hands them to the tab. */
const OFF = {
  create_payment: <button type="button">Turn off create_payment</button>,
};
const OFF_FACTS = {
  create_payment: <span>Turned off by Dana Reyes on 26 September</span>,
};
const FACTS = "Turned off by Dana Reyes on 26 September";

/** The tab's props for one server's page, as an owner or admin sees it. */
function propsOf(
  view: StudioServerView,
  over: Partial<TabProps> = {},
): TabProps {
  return {
    at: STUDIO_AT,
    serverName: view.serverName,
    serverId: view.server.id,
    record: view.record,
    tools: view.tools,
    canEdit: true,
    off: {},
    offFacts: {},
    ...over,
  };
}

function tab(props: TabProps) {
  return (
    <IntlProvider>
      <ToolsTab {...props} />
    </IntlProvider>
  );
}

function renderTab(props: TabProps) {
  return render(tab(props));
}

function row(tool: string): HTMLElement {
  return screen.getByTestId(`studio-tool-${tool}`);
}

/** The tools the table shows, in order. Call it only while the panel is shut. */
function shownTools(): string[] {
  return screen
    .getAllByTestId(/^studio-tool-/)
    .map((node) =>
      (node.getAttribute("data-testid") ?? "").replace("studio-tool-", ""),
    );
}

/** The pager's range, "1–10 of 23", with the catalogue's en dash. */
function range(from: number, to: number, total: number): string {
  return `${String(from)}–${String(to)} of ${String(total)}`;
}

function element(node: Element | null, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`the ${what} is missing`);
  return node;
}

/** The filled part of the budget meter named `name`. */
function meterFill(name: string): HTMLElement {
  return element(
    screen.getByRole("img", { name }).firstElementChild,
    `fill of the meter "${name}"`,
  );
}

/** A stored draft at revision 0, as the store writes it. */
function stored(ops: readonly DraftOp[]): string {
  return JSON.stringify({ revision: 0, ops });
}

/** A draft at its limit: imports of tools no server offers, then `last`. */
function fullDraft(last: DraftOp): DraftOp[] {
  const filler = Array.from(
    { length: DRAFT_LIMIT - 1 },
    (_, index): DraftOp => ({ kind: "import", tool: `extra_${String(index)}` }),
  );
  return [...filler, last];
}

async function openPanel(
  user: ReturnType<typeof userEvent.setup>,
  tool: string,
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: tool }));
  const panel = await screen.findByTestId("studio-tool-panel");
  expect(within(panel).getByRole("heading", { name: tool })).toBeInTheDocument();
  return panel;
}

async function closePanel(
  user: ReturnType<typeof userEvent.setup>,
  panel: HTMLElement,
  tool: string,
): Promise<void> {
  await user.click(within(panel).getByRole("button", { name: `Close ${tool}` }));
  await waitFor(() => {
    expect(screen.queryByTestId("studio-tool-panel")).toBeNull();
  });
}

describe("ToolsTab table", () => {
  it("draws seven columns and an import checkbox on each row for an owner or admin", () => {
    renderTab(propsOf(studioView(STRIPE)));
    expect(screen.getByRole("table", { name: "Tools" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("columnheader").map((head) => head.textContent),
    ).toEqual(["Import", ...COLUMNS]);
    expect(screen.getAllByRole("checkbox")).toHaveLength(23);
    expect(
      screen.getByRole("checkbox", { name: "Import create_payment" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Import create_coupon" }),
    ).not.toBeChecked();
    expect(screen.queryByText(COPY.readOnly)).toBeNull();
    expect(screen.getByText(range(1, 23, 23))).toBeInTheDocument();
    const payment = within(row("create_payment"));
    expect(row("create_payment")).toHaveAttribute("data-state", "imported");
    expect(payment.getByText("Imported")).toBeInTheDocument();
    expect(payment.getByText("412")).toBeInTheDocument();
    expect(payment.getByText("—")).toBeInTheDocument();
    expect(row("create_coupon")).toHaveAttribute("data-state", "available");
    expect(within(row("create_coupon")).getByText("Available")).toBeInTheDocument();
  });

  it("draws six columns and no checkboxes for a member who cannot edit", () => {
    renderTab(propsOf(studioView(STRIPE), { canEdit: false }));
    expect(
      screen.getAllByRole("columnheader").map((head) => head.textContent),
    ).toEqual(COLUMNS);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(COPY.readOnly)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "create_payment" }),
    ).toBeInTheDocument();
  });

  it("shows a confirmed classification plainly and marks an unconfirmed one as suggested", () => {
    renderTab(propsOf(studioView(STRIPE)));
    const payment = within(row("create_payment"));
    expect(payment.getByText("Critical")).toBeInTheDocument();
    expect(payment.getByText("irreversible")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-suggested-create_payment")).toBeNull();
    const customers = within(row("list_customers"));
    expect(customers.getByText("Low")).toBeInTheDocument();
    expect(customers.getByText("read")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-suggested-list_customers")).toBeNull();
    const cancel = within(row("cancel_subscription"));
    expect(cancel.getByText("High")).toBeInTheDocument();
    expect(cancel.getByText("write")).toBeInTheDocument();
    expect(
      screen.getByTestId("studio-suggested-cancel_subscription"),
    ).toHaveTextContent("Suggested");
  });

  it("shows a classification staged in the draft in place of the suggestion", () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [
        {
          kind: "classify",
          tool: "create_coupon",
          risk: "high",
          sideEffect: "irreversible",
          egress: "third_party",
          impacts: [],
        },
      ],
    });
    renderTab(propsOf(studioView(STRIPE)));
    const coupon = within(row("create_coupon"));
    expect(coupon.getByText("High")).toBeInTheDocument();
    expect(coupon.getByText("irreversible")).toBeInTheDocument();
    expect(coupon.queryByText("Medium")).toBeNull();
    expect(screen.queryByTestId("studio-suggested-create_coupon")).toBeNull();
    expect(row("create_coupon")).toHaveAttribute("data-state", "available");
  });

  it("reads a tool with no classification and no token count as unclassified and not recorded", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    await user.type(screen.getByLabelText("Search tools"), "search_documentation");
    expect(shownTools()).toEqual(["search_documentation"]);
    const docs = within(row("search_documentation"));
    expect(docs.getAllByText("Unclassified")).toHaveLength(2);
    const tokens = docs.getByText("not recorded");
    expect(tokens).toHaveAttribute("data-state", "not-recorded");
    expect(tokens).toHaveAttribute("data-gap", "#4678");
  });

  it("shows Billing's unclassified, confirmed and suggested tools", () => {
    renderTab(propsOf(studioView(BILLING)));
    expect(shownTools()).toEqual([
      "create_refund",
      "list_invoices",
      "void_invoice",
    ]);
    const refund = within(row("create_refund"));
    expect(refund.getAllByText("Unclassified")).toHaveLength(2);
    expect(refund.getByText("420")).toBeInTheDocument();
    const invoices = within(row("list_invoices"));
    expect(invoices.getByText("Low")).toBeInTheDocument();
    expect(invoices.getByText("read")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-suggested-list_invoices")).toBeNull();
    const voiding = within(row("void_invoice"));
    expect(voiding.getByText("Critical")).toBeInTheDocument();
    expect(voiding.getByText("irreversible")).toBeInTheDocument();
    expect(screen.getByTestId("studio-suggested-void_invoice")).toBeInTheDocument();
    expect(row("void_invoice")).toHaveAttribute("data-state", "available");
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "800 of 8,000 tokens",
    );
  });

  it("stages an import from an available row and cancels it when the box is cleared", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const box = screen.getByRole("checkbox", { name: "Import create_coupon" });
    await user.click(box);
    expect(box).toBeChecked();
    expect(row("create_coupon")).toHaveAttribute("data-state", "stagedImport");
    expect(within(row("create_coupon")).getByText("Staged import")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBe(
      stored([{ kind: "import", tool: "create_coupon" }]),
    );
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "900 of 8,000 tokens",
    );
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(row("create_coupon")).toHaveAttribute("data-state", "available");
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBeNull();
  });

  it("stages a removal from an imported row and cancels it when the box is checked again", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const box = screen.getByRole("checkbox", { name: "Import list_customers" });
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(row("list_customers")).toHaveAttribute("data-state", "stagedRemove");
    expect(within(row("list_customers")).getByText("Staged removal")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBe(
      stored([{ kind: "remove", tool: "list_customers" }]),
    );
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "412 of 8,000 tokens",
    );
    expect(screen.getByText("Before this draft: 680 tokens")).toBeInTheDocument();
    await user.click(box);
    expect(box).toBeChecked();
    expect(row("list_customers")).toHaveAttribute("data-state", "imported");
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBeNull();
    expect(screen.queryByText(/Before this draft/)).toBeNull();
  });

  it("keeps the registry's tools in the table and keys the draft by server id when there is no record", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(GITHUB)));
    const missing = screen.getByTestId("studio-tools-missing");
    expect(missing).toHaveTextContent(COPY.missing);
    expect(missing).toHaveAttribute("data-gap", "#4678");
    expect(screen.getByTestId("studio-budget-missing")).toBeInTheDocument();
    expect(shownTools()).toEqual(["get_file_contents"]);
    await user.click(
      screen.getByRole("checkbox", { name: "Import get_file_contents" }),
    );
    expect(row("get_file_contents")).toHaveAttribute("data-state", "stagedRemove");
    expect(window.sessionStorage.getItem(idDraftKey(GITHUB))).toBe(
      stored([{ kind: "remove", tool: "get_file_contents" }]),
    );
  });

  it("refuses an edit the draft cannot hold and clears the alert once an edit is kept", async () => {
    const user = userEvent.setup();
    const full = fullDraft({ kind: "import", tool: "create_coupon" });
    seedDraft(draftKey("stripe"), { revision: 0, ops: full });
    renderTab(propsOf(studioView(STRIPE)));
    expect(row("create_coupon")).toHaveAttribute("data-state", "stagedImport");
    const customer = screen.getByRole("checkbox", {
      name: "Import create_customer",
    });
    await user.click(customer);
    expect(screen.getByTestId("studio-tools-refused")).toHaveTextContent(
      COPY.refused,
    );
    expect(customer).not.toBeChecked();
    expect(row("create_customer")).toHaveAttribute("data-state", "available");
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBe(stored(full));
    await user.click(screen.getByRole("checkbox", { name: "Import create_coupon" }));
    expect(screen.queryByTestId("studio-tools-refused")).toBeNull();
    expect(row("create_coupon")).toHaveAttribute("data-state", "available");
    expect(
      parseStoredDraft(window.sessionStorage.getItem(draftKey("stripe"))).ops,
    ).toHaveLength(DRAFT_LIMIT - 1);
    await user.click(customer);
    expect(customer).toBeChecked();
    expect(row("create_customer")).toHaveAttribute("data-state", "stagedImport");
    expect(screen.queryByTestId("studio-tools-refused")).toBeNull();
  });
});

describe("ToolsTab filters and paging", () => {
  it("filters by state and counts a staged import as imported", async () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [{ kind: "import", tool: "create_coupon" }],
    });
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const state = screen.getByRole("combobox", { name: "State" });
    await user.selectOptions(state, "imported");
    expect(shownTools()).toEqual([
      "create_payment",
      "list_customers",
      "create_coupon",
    ]);
    expect(screen.getByText(range(1, 3, 3))).toBeInTheDocument();
    await user.selectOptions(state, "available");
    expect(screen.getByText(range(1, 20, 20))).toBeInTheDocument();
    expect(screen.queryByTestId("studio-tool-create_coupon")).toBeNull();
  });

  it("filters by risk and puts tools with no classification under Unclassified", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const risk = screen.getByRole("combobox", { name: "Risk" });
    await user.selectOptions(risk, "critical");
    expect(shownTools()).toEqual(["create_payment", "create_refund"]);
    expect(screen.getByText(range(1, 2, 2))).toBeInTheDocument();
    await user.selectOptions(risk, "unclassified");
    expect(shownTools()).toEqual(["search_documentation"]);
  });

  it("filters by side effect and follows a classification staged in the draft", async () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [
        {
          kind: "classify",
          tool: "create_coupon",
          risk: "high",
          sideEffect: "irreversible",
          egress: "third_party",
          impacts: [],
        },
      ],
    });
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const sideEffect = screen.getByRole("combobox", { name: "Side effect" });
    await user.selectOptions(sideEffect, "irreversible");
    expect(shownTools()).toEqual([
      "create_payment",
      "create_coupon",
      "create_refund",
    ]);
    await user.selectOptions(sideEffect, "unclassified");
    expect(shownTools()).toEqual(["search_documentation"]);
  });

  it("searches tool names and the descriptions agents see", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const search = screen.getByLabelText("Search tools");
    await user.type(search, "by email");
    expect(shownTools()).toEqual(["list_customers"]);
    await user.clear(search);
    await user.type(search, "charges a customer");
    expect(shownTools()).toEqual(["create_payment"]);
    await user.clear(search);
    await user.type(search, "invoice");
    expect(shownTools()).toEqual([
      "create_invoice",
      "create_invoice_item",
      "finalize_invoice",
      "list_invoices",
    ]);
  });

  it("says no tool matches across all seven columns when a search finds nothing", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    await user.type(screen.getByLabelText("Search tools"), "no_such_tool");
    const cell = screen.getByTestId("studio-tools-no-match");
    expect(cell).toHaveTextContent(COPY.noMatch);
    expect(cell).toHaveAttribute("colspan", "7");
    expect(screen.getByText(range(0, 0, 0))).toBeInTheDocument();
  });

  it("spans the six columns a member sees with the no-match row", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE), { canEdit: false }));
    await user.type(screen.getByLabelText("Search tools"), "no_such_tool");
    expect(screen.getByTestId("studio-tools-no-match")).toHaveAttribute(
      "colspan",
      "6",
    );
  });

  it("pages through Warehouse's 600 tools 25 at a time", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(WAREHOUSE)));
    expect(screen.getByText(range(1, 25, 600))).toBeInTheDocument();
    expect(shownTools()).toEqual(
      Array.from({ length: 25 }, (_, index) => warehouseTool(index * 3)),
    );
    const previous = screen.getByRole("button", { name: "Previous page" });
    expect(previous).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText(range(26, 50, 600))).toBeInTheDocument();
    expect(shownTools()[0]).toBe("tool_075");
    expect(screen.queryByTestId("studio-tool-tool_000")).toBeNull();
    await user.click(previous);
    expect(screen.getByText(range(1, 25, 600))).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Rows per page" }));
    await user.click(await screen.findByRole("option", { name: "50" }));
    await waitFor(() => {
      expect(screen.getByText(range(1, 50, 600))).toBeInTheDocument();
    });
  });

  it("combines filters, so Warehouse shows no available tool that only reads", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(WAREHOUSE)));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "State" }),
      "available",
    );
    expect(screen.getByText(range(1, 25, 400))).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Side effect" }),
      "read",
    );
    expect(screen.getByTestId("studio-tools-no-match")).toBeInTheDocument();
    expect(screen.getByText(range(0, 0, 0))).toBeInTheDocument();
  });
});

describe("ToolsTab budget", () => {
  it("counts the imported tools' tokens against the budget and prints no before line with an empty draft", () => {
    renderTab(propsOf(studioView(STRIPE)));
    const budget = screen.getByTestId("studio-budget");
    expect(
      within(budget).getByRole("heading", { name: "Definition budget" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "680 of 8,000 tokens",
    );
    const name = "680 of 8,000 definition tokens used";
    expect(screen.getByRole("img", { name })).not.toHaveAttribute("data-over");
    expect(meterFill(name)).toHaveStyle({ width: "8.5%" });
    expect(meterFill(name)).toHaveClass("bg-foreground");
    expect(screen.queryByTestId("studio-budget-over")).toBeNull();
    expect(screen.queryByText(/Before this draft/)).toBeNull();
  });

  it("prints the total after the draft and the total before it", () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [{ kind: "import", tool: "create_refund" }],
    });
    renderTab(propsOf(studioView(STRIPE)));
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "998 of 8,000 tokens",
    );
    expect(meterFill("998 of 8,000 definition tokens used")).toHaveStyle({
      width: "12.475%",
    });
    expect(screen.getByText("Before this draft: 680 tokens")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-budget-over")).toBeNull();
  });

  it("says the total is not known when the draft imports a tool with no token count", () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [{ kind: "import", tool: "search_documentation" }],
    });
    renderTab(propsOf(studioView(STRIPE)));
    expect(screen.getByText(COPY.unmeasured)).toBeInTheDocument();
    expect(screen.queryByTestId("studio-budget-used")).toBeNull();
    expect(
      screen.queryByRole("img", { name: /definition tokens used/ }),
    ).toBeNull();
    expect(screen.queryByTestId("studio-budget-over")).toBeNull();
    expect(screen.queryByText(/Before this draft/)).toBeNull();
  });

  it("prints no before line when an imported tool had no token count before the draft", () => {
    seedDraft(draftKey("scratch"), {
      revision: 0,
      ops: [{ kind: "remove", tool: "unmeasured" }],
    });
    renderTab(
      propsOf(studioView(SCRATCH), {
        tools: [studioTool("unmeasured"), studioTool("measured", { tokens: 5 })],
      }),
    );
    expect(row("unmeasured")).toHaveAttribute("data-state", "stagedRemove");
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "5 of 8,000 tokens",
    );
    expect(screen.queryByText(/Before this draft/)).toBeNull();
  });

  it("marks Warehouse over its budget and fills the meter", () => {
    renderTab(propsOf(studioView(WAREHOUSE)));
    expect(screen.getByTestId("studio-budget-over")).toHaveTextContent(
      "Over budget",
    );
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "10,000 of 8,000 tokens",
    );
    const name = "10,000 of 8,000 definition tokens used";
    expect(screen.getByRole("img", { name })).toHaveAttribute(
      "data-over",
      "true",
    );
    expect(meterFill(name)).toHaveStyle({ width: "100%" });
    expect(meterFill(name)).toHaveClass("bg-warning");
  });

  it("fills the meter and marks over budget when the budget is zero", () => {
    const record = stripeRecord();
    renderTab(
      propsOf(
        studioView(STRIPE, {
          ...record,
          exposure: { ...record.exposure, definitionBudget: 0 },
        }),
      ),
    );
    expect(screen.getByTestId("studio-budget-over")).toBeInTheDocument();
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "680 of 0 tokens",
    );
    expect(meterFill("680 of 0 definition tokens used")).toHaveStyle({
      width: "100%",
    });
  });

  it("says the budget is not recorded when the server has no record", () => {
    renderTab(propsOf(studioView(STRIPE, null)));
    const missing = screen.getByTestId("studio-budget-missing");
    expect(missing).toHaveTextContent(COPY.budgetMissing);
    expect(missing).toHaveAttribute("data-gap", "#4678");
    expect(screen.queryByTestId("studio-budget")).toBeNull();
    expect(screen.getByTestId("studio-tools-missing")).toBeInTheDocument();
    expect(shownTools()).toEqual(["create_payment"]);
  });
});

describe("ToolsTab empty and missing states", () => {
  it("shows the empty state for a recorded server that offers no tools", () => {
    renderTab(propsOf(studioView(SCRATCH)));
    const empty = screen.getByTestId("studio-tools-empty");
    expect(
      within(empty).getByRole("heading", { name: "No tools" }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent(COPY.emptyBody);
    expect(screen.queryByTestId("studio-tools")).toBeNull();
    expect(screen.queryByTestId("studio-tools-missing")).toBeNull();
    expect(screen.getByTestId("studio-budget-used")).toHaveTextContent(
      "0 of 8,000 tokens",
    );
  });

  it("draws neither a table nor the empty state when there is no record and no tool", () => {
    renderTab(
      propsOf(studioView(SCRATCH), {
        serverName: null,
        record: null,
        tools: [],
      }),
    );
    expect(screen.getByTestId("studio-tools-missing")).toHaveTextContent(
      COPY.missing,
    );
    expect(screen.getByTestId("studio-budget-missing")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-tools-empty")).toBeNull();
    expect(screen.queryByTestId("studio-tools")).toBeNull();
  });
});

describe("ToolsTab kill switches", () => {
  it("puts each tool's off control in its own row and keeps the facts for the panel", () => {
    renderTab(
      propsOf(studioView(STRIPE), { off: OFF, offFacts: OFF_FACTS }),
    );
    expect(
      within(row("create_payment")).getByRole("button", {
        name: "Turn off create_payment",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Turn off create_payment" }),
    ).toHaveLength(1);
    expect(within(row("list_customers")).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(FACTS)).toBeNull();
  });

  it("shows Off for a tool whose switch is on and a dash once the switch is cleared", () => {
    const view = studioView(
      STRIPE,
      stripeRecord(),
      studioBoard([offSwitch("emd_01k5d1", "tool_version", "tlv_01k5a1")]),
    );
    const { rerender } = renderTab(propsOf(view));
    expect(within(row("create_payment")).getByText("Off")).toBeInTheDocument();
    expect(within(row("list_customers")).getByText("—")).toBeInTheDocument();
    const cleared = view.tools.map(
      (tool): StudioTool =>
        tool.killSwitch === null
          ? tool
          : { ...tool, killSwitch: { ...tool.killSwitch, on: false } },
    );
    rerender(tab(propsOf(view, { tools: cleared })));
    expect(within(row("create_payment")).queryByText("Off")).toBeNull();
    expect(within(row("create_payment")).getByText("—")).toBeInTheDocument();
  });

  it("draws the server's off control in place of the Off badge", () => {
    const view = studioView(
      STRIPE,
      stripeRecord(),
      studioBoard([offSwitch("emd_01k5d1", "tool_version", "tlv_01k5a1")]),
    );
    renderTab(propsOf(view, { off: OFF }));
    const payment = within(row("create_payment"));
    expect(
      payment.getByRole("button", { name: "Turn off create_payment" }),
    ).toBeInTheDocument();
    expect(payment.queryByText("Off")).toBeNull();
  });
});

describe("ToolsTab tool panel", () => {
  it("opens a tool's panel from its name and closes it from the header or the footer", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    expect(screen.queryByTestId("studio-tool-panel")).toBeNull();
    const first = await openPanel(user, "create_payment");
    await closePanel(user, first, "create_payment");
    const second = await openPanel(user, "list_customers");
    await user.click(within(second).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("studio-tool-panel")).toBeNull();
    });
    expect(row("list_customers")).toHaveAttribute("data-state", "imported");
  });

  it("starts each tool's panel from that tool's own description and drops text typed for another", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const payment = await openPanel(user, "create_payment");
    const typed = within(payment).getByTestId("studio-panel-description");
    await user.clear(typed);
    await user.type(typed, "Typed for create_payment only.");
    expect(typed).toHaveValue("Typed for create_payment only.");
    await closePanel(user, payment, "create_payment");
    const customers = await openPanel(user, "list_customers");
    expect(
      within(customers).getByTestId("studio-panel-description"),
    ).toHaveValue("Lists Stripe customers by email.");
    await closePanel(user, customers, "list_customers");
    const again = await openPanel(user, "create_payment");
    expect(within(again).getByTestId("studio-panel-description")).toHaveValue(
      "Charges a customer.",
    );
    await closePanel(user, again, "create_payment");
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBeNull();
  });

  it("hands a tool's off control and facts to its panel and none to a tool without them", async () => {
    const user = userEvent.setup();
    renderTab(
      propsOf(studioView(STRIPE), { off: OFF, offFacts: OFF_FACTS }),
    );
    const payment = await openPanel(user, "create_payment");
    expect(
      within(payment).getByRole("button", { name: "Turn off create_payment" }),
    ).toBeInTheDocument();
    expect(within(payment).getByText(FACTS)).toBeInTheDocument();
    await closePanel(user, payment, "create_payment");
    const customers = await openPanel(user, "list_customers");
    expect(
      within(customers).queryByRole("button", {
        name: "Turn off create_payment",
      }),
    ).toBeNull();
    expect(within(customers).queryByText(FACTS)).toBeNull();
    expect(within(customers).getByText(COPY.offNone)).toBeInTheDocument();
    await closePanel(user, customers, "list_customers");
  });

  it("passes the draft seam to the panel for the tool it opened", async () => {
    const user = userEvent.setup();
    const { draft, calls } = fakeDraft({
      ok: true,
      description: "Charges a customer once, in cents.",
    });
    renderTab(propsOf(studioView(STRIPE), { draft }));
    const panel = await openPanel(user, "create_payment");
    await user.click(within(panel).getByTestId("studio-panel-draft"));
    await waitFor(() => {
      expect(within(panel).getByTestId("studio-panel-description")).toHaveValue(
        "Charges a customer once, in cents.",
      );
    });
    expect(calls).toEqual([{ server: "stripe", tool: "create_payment" }]);
    await closePanel(user, panel, "create_payment");
  });

  it("falls back to the pending Draft stub when the page passes none", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    const panel = await openPanel(user, "create_payment");
    expect(within(panel).getByTestId("studio-panel-draft")).toBeDisabled();
    const note = within(panel).getByTestId("studio-panel-draft-pending");
    expect(note).toHaveAttribute("data-gap", "#4742");
    expect(note).toHaveTextContent(COPY.draftNotBuilt);
    await closePanel(user, panel, "create_payment");
  });

  it("opens a read-only panel for a member who cannot edit", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE), { canEdit: false }));
    const panel = await openPanel(user, "create_payment");
    expect(within(panel).queryByTestId("studio-panel-draft")).toBeNull();
    expect(
      within(panel).queryByTestId("studio-panel-stage-classification"),
    ).toBeNull();
    await closePanel(user, panel, "create_payment");
  });

  it("stages a suggestion confirmed in the panel into the tab's draft", async () => {
    const user = userEvent.setup();
    renderTab(propsOf(studioView(STRIPE)));
    await user.click(
      screen.getByRole("checkbox", { name: "Import cancel_subscription" }),
    );
    expect(
      screen.getByTestId("studio-suggested-cancel_subscription"),
    ).toBeInTheDocument();
    const panel = await openPanel(user, "cancel_subscription");
    await user.click(
      within(panel).getByRole("button", { name: "Confirm suggestion" }),
    );
    expect(within(panel).getByTestId("studio-panel-staged")).toBeInTheDocument();
    expect(
      screen.queryByTestId("studio-suggested-cancel_subscription"),
    ).toBeNull();
    expect(
      parseStoredDraft(window.sessionStorage.getItem(draftKey("stripe"))).ops,
    ).toEqual([
      { kind: "import", tool: "cancel_subscription" },
      {
        kind: "classify",
        tool: "cancel_subscription",
        risk: "high",
        sideEffect: "write",
        egress: "third_party",
        impacts: ["changes_entitlement"],
      },
    ]);
    await closePanel(user, panel, "cancel_subscription");
    expect(within(row("cancel_subscription")).getByText("High")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-tools-refused")).toBeNull();
  });

  it("shows a refused panel edit once, in the panel, and not on the tab", async () => {
    const user = userEvent.setup();
    const full = fullDraft({ kind: "import", tool: "cancel_subscription" });
    seedDraft(draftKey("stripe"), { revision: 0, ops: full });
    renderTab(propsOf(studioView(STRIPE)));
    const panel = await openPanel(user, "cancel_subscription");
    await user.click(
      within(panel).getByRole("button", { name: "Confirm suggestion" }),
    );
    expect(within(panel).getByTestId("studio-panel-refused")).toHaveTextContent(
      COPY.refused,
    );
    expect(screen.queryByTestId("studio-tools-refused")).toBeNull();
    expect(screen.getAllByText(COPY.refused)).toHaveLength(1);
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBe(stored(full));
    await closePanel(user, panel, "cancel_subscription");
    expect(screen.queryByTestId("studio-tools-refused")).toBeNull();
  });

  it("clears the tab's refusal when the next edit comes from the panel", async () => {
    const user = userEvent.setup();
    const full = fullDraft({ kind: "import", tool: "cancel_subscription" });
    seedDraft(draftKey("stripe"), { revision: 0, ops: full });
    renderTab(propsOf(studioView(STRIPE)));
    await user.click(
      screen.getByRole("checkbox", { name: "Import create_customer" }),
    );
    expect(screen.getByTestId("studio-tools-refused")).toHaveTextContent(
      COPY.refused,
    );
    const panel = await openPanel(user, "cancel_subscription");
    await user.click(
      within(panel).getByRole("button", { name: "Confirm suggestion" }),
    );
    expect(screen.queryByTestId("studio-tools-refused")).toBeNull();
    expect(within(panel).getByTestId("studio-panel-refused")).toBeInTheDocument();
    expect(screen.getAllByText(COPY.refused)).toHaveLength(1);
    await closePanel(user, panel, "cancel_subscription");
    expect(screen.queryByTestId("studio-tools-refused")).toBeNull();
  });
});
