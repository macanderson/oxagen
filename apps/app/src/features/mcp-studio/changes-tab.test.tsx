// @vitest-environment jsdom
// The Changes tab of a Studio server (#4678). It shows the draft's tool
// surface diff, the staged edits, the files the steering PR would change and
// the tool checks' findings. It opens the steering PR through lane M11's
// three capabilities: save the draft over the revision it was built on, read
// the stored draft back after a conflict, and open the steering PR from the
// saved revision. Each test fakes what M11 answers and checks what the tab
// shows and what it sends. The browser never sends the server's definition or
// a credential, a conflict reloads and merges without trying again, a stored
// draft the page cannot read leaves the tab's edits alone, and the draft
// stays in the tab after Review.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ChangesTab } from "./changes-tab";
import type { DraftOp } from "./draft";
import type { SaveStudioDraft } from "./seams";
import {
  BILLING,
  draftKey,
  fakeGet,
  fakeOpen,
  fakeSave,
  GITHUB,
  idDraftKey,
  recordOf,
  SCRATCH,
  savedDraft,
  seedDraft,
  STRIPE,
  STUDIO_AT,
  studioFindings,
  studioReview,
  studioView,
  WAREHOUSE,
  warehouseTool,
} from "./studio.builders";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// With no seam passed, the tab calls these server actions (review-calls.ts).
const actions = vi.hoisted(() => ({
  saveStudioDraftAction: vi.fn(),
  saveNewStudioServerAction: vi.fn(),
  getStudioDraftAction: vi.fn(),
  openStudioReviewAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

type TabProps = ComponentProps<typeof ChangesTab>;
type SaveInput = Parameters<SaveStudioDraft>[0];
type SaveAnswer = Awaited<ReturnType<SaveStudioDraft>>;

const IMPORT_REFUND: DraftOp = { kind: "import", tool: "create_refund" };
const IMPORT_SEARCH: DraftOp = {
  kind: "import",
  tool: "search_documentation",
};
const REMOVE_CUSTOMERS: DraftOp = { kind: "remove", tool: "list_customers" };
const CLASSIFY_PAYMENT: DraftOp = {
  kind: "classify",
  tool: "create_payment",
  risk: "critical",
  sideEffect: "irreversible",
  egress: "third_party",
  impacts: ["moves_money"],
};
const DESCRIBE_PAYMENT: DraftOp = {
  kind: "describe",
  tool: "create_payment",
  description: "Charges a customer. The amount is in cents.",
};
const TEST_CUSTOMERS: DraftOp = {
  kind: "test",
  tool: "list_customers",
  environment: "default",
  args: JSON.stringify({ email: "ada@example.com" }),
  request: JSON.stringify({
    method: "tools/call",
    params: { name: "list_customers" },
  }),
  raw: JSON.stringify({ content: [] }),
  shaped: JSON.stringify({ content: [] }),
};
const IMPORT_VOID: DraftOp = { kind: "import", tool: "void_invoice" };
const CLASSIFY_REFUND: DraftOp = {
  kind: "classify",
  tool: "create_refund",
  risk: "critical",
  sideEffect: "irreversible",
  egress: "org_tenant",
  impacts: ["moves_money"],
};

const CONFLICT =
  "Someone saved this server's draft after you last did. Your edits are now staged on top of theirs. Check the edits, then open the steering PR again.";
const KEPT =
  "Someone saved this server's draft after you last did, in a form this page cannot read. Your edits are unchanged, and Oxagen kept theirs. Reload the page to get a version that can read their edits, then open the steering PR again.";
const THROWN =
  "The steering PR did not open because the request failed before Oxagen answered. Try again.";
const UNAVAILABLE =
  "Oxagen could not open the steering PR just now. Try again in a minute.";
const STALE = {
  ok: false,
  reason: "conflict",
  code: "draft_revision_stale",
} as const;
const SOURCE_MISSING =
  "The steering PR needs the server's definition to go with this draft, and Oxagen has not recorded it yet.";
const PR_URL = "https://github.com/acme/steering/pull/4721";

function renderTab(serverId: string, over: Partial<TabProps> = {}) {
  const view = studioView(serverId);
  const props: TabProps = {
    at: STUDIO_AT,
    serverName: view.serverName,
    serverId,
    record: view.record,
    sourceType: view.record?.source.type ?? null,
    tools: view.tools,
    findings: null,
    canEdit: true,
    ...over,
  };
  return render(
    <IntlProvider>
      <ChangesTab {...props} />
    </IntlProvider>,
  );
}

function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}

/** The draft the tab stored under `key`, parsed; null when none is stored. */
function stored(key: string): unknown {
  const text = window.sessionStorage.getItem(key);
  if (text === null) return null;
  const value: unknown = JSON.parse(text);
  return value;
}

/** The token line's text: its label, before, an arrow, "to", then after. */
function tokenLine(before: string, after: string): string {
  return `Definition tokens${before}→to${after}`;
}

function tokens(): string | null {
  return screen.getByTestId("studio-changes-tokens").textContent;
}

function files(): (string | null)[] {
  return within(screen.getByTestId("studio-changes-files"))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

/** One value of the steering PR summary, found by its term. */
function summaryValue(term: string): string | null {
  const summary = screen.getByTestId("studio-review-summary");
  return element(
    within(summary).getByText(term).nextElementSibling,
    `${term} value`,
  ).textContent;
}

function openSteeringPr(): void {
  fireEvent.click(screen.getByTestId("studio-pr-open"));
}

/** A saved test of list_customers, one per page number. */
function savedTest(page: number): DraftOp {
  return {
    kind: "test",
    tool: "list_customers",
    environment: "default",
    args: JSON.stringify({ page }),
    request: JSON.stringify({ method: "tools/call" }),
    raw: JSON.stringify({ content: [] }),
    shaped: JSON.stringify({ content: [] }),
  };
}

/** A save that holds its answer until the test releases it. */
function heldSave() {
  const calls: SaveInput[] = [];
  const waiting: ((answer: SaveAnswer) => void)[] = [];
  const save: SaveStudioDraft = (input) => {
    calls.push(input);
    return new Promise<SaveAnswer>((resolve) => {
      waiting.push(resolve);
    });
  };
  const release = (answer: SaveAnswer): void => {
    const resolve = waiting.shift();
    if (resolve === undefined) throw new Error("no save is waiting");
    resolve(answer);
  };
  return { save, calls, release };
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    window.sessionStorage.clear();
  }
});

describe("ChangesTab tool surface", () => {
  it("shows the empty state with the buttons off when nothing is staged", () => {
    renderTab(SCRATCH);
    const empty = screen.getByTestId("studio-changes-empty");
    expect(empty).toHaveTextContent("No changes");
    expect(empty).toHaveTextContent(
      "Edits you make on the Tools tab and tests you save on the Test tab collect here.",
    );
    expect(screen.queryByTestId("studio-changes-surface")).toBeNull();
    expect(screen.queryByTestId("studio-changes-edits")).toBeNull();
    expect(screen.queryByTestId("studio-changes-files")).toBeNull();
    expect(screen.getByTestId("studio-pr-open")).toBeDisabled();
    expect(screen.getByTestId("studio-draft-discard")).toBeDisabled();
  });

  it("adds an imported tool's tokens to the total and lists the files the steering PR changes", () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    renderTab(STRIPE);
    expect(screen.queryByTestId("studio-changes-empty")).toBeNull();
    expect(tokens()).toBe(tokenLine("680", "998"));
    const row = screen.getByTestId("studio-change-create_refund");
    expect(row).toHaveAttribute("data-change", "added");
    expect(within(row).getByText("Added")).toBeInTheDocument();
    expect(within(row).getByText("+318 tokens")).toBeInTheDocument();
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Import create_refund",
    );
    expect(files()).toEqual([
      "tools/servers/stripe/tools.toml",
      "tools/servers/stripe/tools.lock.json",
    ]);
    expect(screen.queryByTestId("studio-folder-missing")).toBeNull();
  });

  it("reads the total as not recorded when an imported tool has no token count", () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_SEARCH] });
    renderTab(STRIPE);
    expect(tokens()).toBe(tokenLine("680", "not recorded"));
    const unrecorded = within(
      screen.getByTestId("studio-changes-tokens"),
    ).getByText("not recorded");
    expect(unrecorded).toHaveAttribute("data-state", "not-recorded");
    expect(unrecorded).toHaveAttribute("data-gap", "#4678");
    const row = screen.getByTestId("studio-change-search_documentation");
    expect(row).toHaveAttribute("data-change", "added");
    expect(within(row).getByText("not measured")).toBeInTheDocument();
  });

  it("takes a removed tool's tokens off the total", () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [REMOVE_CUSTOMERS] });
    renderTab(STRIPE);
    expect(tokens()).toBe(tokenLine("680", "412"));
    const row = screen.getByTestId("studio-change-list_customers");
    expect(row).toHaveAttribute("data-change", "removed");
    expect(within(row).getByText("Removed")).toBeInTheDocument();
    expect(within(row).getByText("−268 tokens")).toBeInTheDocument();
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Remove list_customers",
    );
  });

  it("shows a classification and a description of one tool as one changed line", () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [CLASSIFY_PAYMENT, DESCRIBE_PAYMENT],
    });
    renderTab(STRIPE);
    expect(tokens()).toBe(tokenLine("680", "680"));
    const row = screen.getByTestId("studio-change-create_payment");
    expect(row).toHaveAttribute("data-change", "changed");
    expect(within(row).getByText("Changed")).toBeInTheDocument();
    expect(
      within(row).getByText("classification, description"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Classify create_payment: risk Critical, side effect irreversible",
    );
    expect(screen.getByTestId("studio-edit-1")).toHaveTextContent(
      "Describe create_payment",
    );
    // Only tools.toml changes: the lock follows imports and removals.
    expect(files()).toEqual(["tools/servers/stripe/tools.toml"]);
  });

  it("says the tools agents see do not change when the draft only adds a test", () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [TEST_CUSTOMERS] });
    renderTab(STRIPE);
    expect(
      screen.getByText("The tools agents see do not change."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Tool surface" })).toBeNull();
    expect(tokens()).toBe(tokenLine("680", "680"));
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Add a test call to list_customers in default",
    );
    expect(files()).toEqual(["tools/servers/stripe/tests/calls.jsonl"]);
  });

  it("reads a total already over the definition budget when one more Warehouse tool is imported", () => {
    seedDraft(draftKey("warehouse"), {
      revision: 0,
      ops: [{ kind: "import", tool: warehouseTool(1) }],
    });
    renderTab(WAREHOUSE);
    expect(tokens()).toBe(tokenLine("10,000", "10,050"));
    // Warehouse lists its tools through search, so the budget does not apply.
    expect(screen.queryByTestId("studio-pr-over-budget")).toBeNull();
    const row = screen.getByTestId(`studio-change-${warehouseTool(1)}`);
    expect(row).toHaveAttribute("data-change", "added");
    expect(within(row).getByText("+50 tokens")).toBeInTheDocument();
    expect(files()).toEqual([
      "tools/servers/warehouse/tools.toml",
      "tools/servers/warehouse/tools.lock.json",
    ]);
  });
});

describe("ChangesTab findings", () => {
  it("says findings wait on the record when none could be read", () => {
    renderTab(BILLING, { findings: null });
    const missing = screen.getByTestId("studio-findings-missing");
    expect(missing).toHaveAttribute("role", "note");
    expect(missing).toHaveAttribute("data-gap", "#4678");
    expect(missing).toHaveTextContent(
      "Findings show once this server's folder is recorded.",
    );
  });

  it("says the tool checks found nothing when the list is empty", () => {
    renderTab(BILLING, { findings: [] });
    expect(screen.getByTestId("studio-findings-none")).toHaveTextContent(
      "The tool checks found nothing.",
    );
    expect(screen.queryAllByTestId("studio-finding")).toHaveLength(0);
  });

  it("lists each finding with its level, rule, tool, field, message and fix", () => {
    renderTab(BILLING, { findings: studioFindings() });
    const [error, warning, info] = screen.getAllByTestId("studio-finding");
    const first = element(error, "error finding");
    expect(first).toHaveAttribute("data-level", "error");
    expect(within(first).getByText("Error")).toBeInTheDocument();
    expect(
      within(first).getByText("missing_classification"),
    ).toBeInTheDocument();
    expect(within(first).getByText("create_refund")).toBeInTheDocument();
    expect(
      within(first).getByText(
        "create_refund is imported with no classification.",
      ),
    ).toBeInTheDocument();
    expect(
      within(first).getByText("Classify create_refund."),
    ).toBeInTheDocument();
    const second = element(warning, "warning finding");
    expect(second).toHaveAttribute("data-level", "warning");
    expect(within(second).getByText("Warning")).toBeInTheDocument();
    expect(
      within(second).getByText("inputSchema.properties.status.enum"),
    ).toBeInTheDocument();
    const third = element(info, "info finding");
    expect(third).toHaveAttribute("data-level", "info");
    expect(within(third).getByText("Info")).toBeInTheDocument();
    // A finding on no one tool is about the server as a whole.
    expect(within(third).getByText("Server")).toBeInTheDocument();
  });
});

describe("ChangesTab steering PR", () => {
  it("saves the draft over revision 0, then opens the steering PR from the saved revision", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({
        server: "stripe",
        serverId: STRIPE,
        ops: [IMPORT_REFUND],
        source: { type: "mcp", bytes: 18_432 },
        revision: 1,
      }),
    });
    const get = fakeGet();
    const open = fakeOpen({
      ok: true,
      review: studioReview({ branch: "studio/stripe" }),
    });
    renderTab(STRIPE, {
      findings: studioFindings(),
      save: save.save,
      get: get.get,
      open: open.open,
    });
    expect(screen.getAllByTestId("studio-finding")).toHaveLength(3);
    openSteeringPr();
    const opened = await screen.findByTestId("studio-pr-opened");
    // The browser sends no serverToml, no source and no credential.
    expect(save.calls).toStrictEqual([
      { server: "stripe", serverId: STRIPE, ops: [IMPORT_REFUND], revision: 0 },
    ]);
    expect(JSON.stringify(save.calls)).not.toContain("oxagen:credential");
    expect(open.calls).toStrictEqual([{ server: "stripe", revision: 1 }]);
    expect(get.calls).toEqual([]);
    expect(opened).toHaveAttribute("role", "status");
    expect(opened).not.toHaveAttribute("data-updated");
    const link = within(opened).getByRole("link", {
      name: "Opened steering PR #4721",
    });
    expect(link).toHaveAttribute("href", PR_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(summaryValue("Branch")).toBe("studio/stripe");
    expect(screen.getByTestId("studio-review-branch")).toHaveTextContent(
      "studio/stripe",
    );
    expect(summaryValue("Imported tools")).toBe("1");
    expect(summaryValue("Removed tools")).toBe("0");
    expect(summaryValue("Reclassified tools")).toBe("1");
    expect(screen.getByTestId("studio-review-tokens")).toHaveTextContent(
      "1,150 of 8,000",
    );
    // Review ran the checks again, so its findings replace the folder's.
    expect(screen.getByTestId("studio-findings-none")).toBeInTheDocument();
    expect(screen.queryAllByTestId("studio-finding")).toHaveLength(0);
    // The draft stays after Review, at the saved revision.
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 1,
      ops: [IMPORT_REFUND],
    });
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Import create_refund",
    );
    const button = screen.getByTestId("studio-pr-open");
    expect(button).toHaveTextContent("Open steering PR");
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("names the steering PR as updated when an earlier Review opened it", async () => {
    seedDraft(draftKey("billing"), {
      revision: 2,
      ops: [IMPORT_VOID, CLASSIFY_REFUND],
    });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({
        ops: [IMPORT_VOID, CLASSIFY_REFUND],
        source: { type: "openapi", bytes: 52_000 },
        revision: 3,
        pr: { number: 4721, url: PR_URL, branch: "studio/billing" },
      }),
    });
    const open = fakeOpen({
      ok: true,
      review: studioReview({ findings: studioFindings().slice(0, 1) }),
    });
    renderTab(BILLING, { save: save.save, open: open.open });
    expect(tokens()).toBe(tokenLine("800", "1,150"));
    openSteeringPr();
    const opened = await screen.findByTestId("studio-pr-opened");
    expect(opened).toHaveAttribute("data-updated", "true");
    expect(
      within(opened).getByRole("link", { name: "Updated steering PR #4721" }),
    ).toHaveAttribute("href", PR_URL);
    expect(save.calls).toStrictEqual([
      {
        server: "billing",
        serverId: BILLING,
        ops: [IMPORT_VOID, CLASSIFY_REFUND],
        revision: 2,
      },
    ]);
    expect(open.calls).toStrictEqual([{ server: "billing", revision: 3 }]);
    // The folder had no findings; Review's own replace the not-run note.
    expect(screen.queryByTestId("studio-findings-missing")).toBeNull();
    expect(screen.getAllByTestId("studio-finding")).toHaveLength(1);
  });

  it("opens the steering PR with no definition attached when the draft imports nothing", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({ ops: [CLASSIFY_REFUND], revision: 3 }),
    });
    const open = fakeOpen({ ok: true, review: studioReview() });
    renderTab(BILLING, { save: save.save, open: open.open });
    openSteeringPr();
    expect(await screen.findByTestId("studio-pr-opened")).toHaveTextContent(
      "Opened steering PR #4721",
    );
    expect(open.calls).toStrictEqual([{ server: "billing", revision: 3 }]);
  });

  it("shows the steering PR as plain text when its URL is not a pull request page", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({ ops: [CLASSIFY_REFUND], revision: 3 }),
    });
    const open = fakeOpen({
      ok: true,
      review: studioReview({ url: "https://example.com/acme/steering/4721" }),
    });
    renderTab(BILLING, { save: save.save, open: open.open });
    openSteeringPr();
    const opened = await screen.findByTestId("studio-pr-opened");
    expect(opened.textContent).toBe("Opened steering PR #4721");
    expect(within(opened).queryByRole("link")).toBeNull();
  });

  it("holds the buttons while the steering PR is opening and ignores a second press", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const held = heldSave();
    renderTab(STRIPE, { save: held.save });
    openSteeringPr();
    const button = screen.getByTestId("studio-pr-open");
    expect(button).toHaveTextContent("Opening");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("studio-draft-discard")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove the edit to create_refund" }),
    ).toBeDisabled();
    openSteeringPr();
    expect(held.calls).toHaveLength(1);
    held.release({ ok: false, reason: "failed", code: "unavailable" });
    expect(await screen.findByTestId("studio-pr-failed")).toHaveTextContent(
      UNAVAILABLE,
    );
    expect(button).toHaveTextContent("Open steering PR");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(screen.getByTestId("studio-draft-discard")).toBeEnabled();
  });

  it("calls lane M11's capabilities through the server actions when no seam is passed", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    actions.saveStudioDraftAction.mockResolvedValueOnce({
      ok: true,
      value: savedDraft({ ops: [CLASSIFY_REFUND], revision: 3 }),
    });
    actions.openStudioReviewAction.mockResolvedValueOnce({
      ok: true,
      value: studioReview(),
    });
    renderTab(BILLING);
    openSteeringPr();
    expect(await screen.findByTestId("studio-pr-opened")).toHaveTextContent(
      "Opened steering PR #4721",
    );
    expect(actions.saveStudioDraftAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      {
        server: "billing",
        serverId: BILLING,
        ops: [CLASSIFY_REFUND],
        revision: 2,
      },
    );
    expect(actions.openStudioReviewAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      { server: "billing", revision: 3 },
    );
    expect(actions.getStudioDraftAction).not.toHaveBeenCalled();
  });

  it("keeps the edits it sent when the saved draft's edits do not read back", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({ ops: [{ kind: "rename", tool: "x" }], revision: 3 }),
    });
    const open = fakeOpen({ ok: true, review: studioReview() });
    renderTab(BILLING, { save: save.save, open: open.open });
    openSteeringPr();
    await screen.findByTestId("studio-pr-opened");
    expect(stored(draftKey("billing"))).toEqual({
      revision: 3,
      ops: [CLASSIFY_REFUND],
    });
  });
});

describe("ChangesTab definition budget", () => {
  it("warns before opening when the draft's tools pass a direct server's budget", () => {
    seedDraft(draftKey("billing"), {
      revision: 2,
      ops: [IMPORT_VOID, CLASSIFY_REFUND],
    });
    const record = recordOf(BILLING);
    if (record === null) throw new Error("no billing record");
    renderTab(BILLING, {
      record: {
        ...record,
        exposure: { mode: "direct", definitionBudget: 1_000 },
      },
    });
    expect(tokens()).toBe(tokenLine("800", "1,150"));
    const warning = screen.getByTestId("studio-pr-over-budget");
    expect(warning).toHaveTextContent("Over budget");
    expect(warning).toHaveTextContent(
      "The imported tools come to 1,150 definition tokens, over this server's budget of 1,000. The steering PR will carry an over-budget warning.",
    );
    // The warning never blocks: lint's finding is a warning.
    expect(screen.getByTestId("studio-pr-open")).toBeEnabled();
  });

  it("does not warn at the budget, or for a server in search mode", () => {
    seedDraft(draftKey("billing"), {
      revision: 2,
      ops: [IMPORT_VOID, CLASSIFY_REFUND],
    });
    const record = recordOf(BILLING);
    if (record === null) throw new Error("no billing record");
    const { unmount } = renderTab(BILLING, {
      record: {
        ...record,
        exposure: { mode: "direct", definitionBudget: 1_150 },
      },
    });
    expect(screen.queryByTestId("studio-pr-over-budget")).toBeNull();
    unmount();
    renderTab(BILLING, {
      record: {
        ...record,
        exposure: { mode: "search", definitionBudget: 1_000 },
      },
    });
    expect(screen.queryByTestId("studio-pr-over-budget")).toBeNull();
  });
});

describe("ChangesTab conflict", () => {
  it("reloads the stored draft on a conflict, stages this tab's edits on top, and waits for the person to open again", async () => {
    seedDraft(draftKey("stripe"), { revision: 1, ops: [IMPORT_REFUND] });
    const save = fakeSave(
      STALE,
      {
        ok: true,
        draft: savedDraft({
          server: "stripe",
          serverId: STRIPE,
          ops: [REMOVE_CUSTOMERS, IMPORT_REFUND],
          source: { type: "mcp", bytes: 18_432 },
          revision: 4,
        }),
      },
    );
    const get = fakeGet({
      ok: true,
      draft: savedDraft({
        server: "stripe",
        serverId: STRIPE,
        ops: [REMOVE_CUSTOMERS],
        revision: 3,
      }),
    });
    const open = fakeOpen({ ok: true, review: studioReview() });
    renderTab(STRIPE, { save: save.save, get: get.get, open: open.open });
    openSteeringPr();
    const alert = await screen.findByTestId("studio-pr-conflict");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.textContent).toBe(CONFLICT);
    expect(get.calls).toStrictEqual([{ server: "stripe" }]);
    // No retry: one save, and no Review until the person presses again.
    expect(save.calls).toHaveLength(1);
    expect(open.calls).toHaveLength(0);
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 3,
      ops: [REMOVE_CUSTOMERS, IMPORT_REFUND],
    });
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Remove list_customers",
    );
    expect(screen.getByTestId("studio-edit-1")).toHaveTextContent(
      "Import create_refund",
    );
    openSteeringPr();
    expect(await screen.findByTestId("studio-pr-opened")).toHaveTextContent(
      "Opened steering PR #4721",
    );
    expect(save.calls[1]).toStrictEqual({
      server: "stripe",
      serverId: STRIPE,
      ops: [REMOVE_CUSTOMERS, IMPORT_REFUND],
      revision: 3,
    });
    expect(open.calls).toStrictEqual([{ server: "stripe", revision: 4 }]);
    expect(screen.queryByTestId("studio-pr-conflict")).toBeNull();
  });

  it("counts the edits that no longer fit the stored draft, and Discard clears the notice", async () => {
    // The stored draft is full: 2,000 edits, the most a draft holds.
    const theirs = Array.from({ length: 2_000 }, (_, page) => savedTest(page));
    seedDraft(draftKey("stripe"), {
      revision: 1,
      ops: [savedTest(0), IMPORT_REFUND],
    });
    const save = fakeSave(STALE);
    const get = fakeGet({
      ok: true,
      draft: savedDraft({
        server: "stripe",
        serverId: STRIPE,
        ops: theirs,
        revision: 5,
      }),
    });
    const open = fakeOpen();
    renderTab(STRIPE, { save: save.save, get: get.get, open: open.open });
    openSteeringPr();
    const alert = await screen.findByTestId("studio-pr-conflict");
    // The test already stored is skipped and not counted. The import would
    // make 2,001 edits, so it is left out.
    expect(alert.textContent).toBe(
      `${CONFLICT} 1 edit did not fit the saved draft and was left out.`,
    );
    expect(stored(draftKey("stripe"))).toEqual({ revision: 5, ops: theirs });
    expect(
      screen.getByTestId("studio-changes-edits").querySelectorAll("li"),
    ).toHaveLength(2_000);
    expect(open.calls).toHaveLength(0);
    fireEvent.click(screen.getByTestId("studio-draft-discard"));
    expect(screen.queryByTestId("studio-pr-conflict")).toBeNull();
    expect(screen.getByTestId("studio-changes-empty")).toBeInTheDocument();
    expect(stored(draftKey("stripe"))).toEqual({ revision: 5, ops: [] });
  });

  it("stages this tab's draft as a new one when the stored draft is gone", async () => {
    seedDraft(draftKey("stripe"), { revision: 2, ops: [DESCRIBE_PAYMENT] });
    const save = fakeSave(STALE);
    const get = fakeGet({ ok: true, draft: null });
    const open = fakeOpen();
    renderTab(STRIPE, { save: save.save, get: get.get, open: open.open });
    openSteeringPr();
    const alert = await screen.findByTestId("studio-pr-conflict");
    expect(alert.textContent).toBe(CONFLICT);
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 0,
      ops: [DESCRIBE_PAYMENT],
    });
    expect(open.calls).toHaveLength(0);
  });

  it("shows the failure and keeps the draft when the stored draft cannot be read", async () => {
    seedDraft(draftKey("stripe"), { revision: 1, ops: [IMPORT_REFUND] });
    const save = fakeSave(STALE);
    const get = fakeGet({ ok: false, reason: "failed", code: "unavailable" });
    renderTab(STRIPE, { save: save.save, get: get.get });
    openSteeringPr();
    expect(await screen.findByTestId("studio-pr-failed")).toHaveTextContent(
      UNAVAILABLE,
    );
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 1,
      ops: [IMPORT_REFUND],
    });
  });

  it("keeps its own revision when the stored draft does not fit the draft shape, so it cannot save over it", async () => {
    seedDraft(draftKey("stripe"), { revision: 1, ops: [IMPORT_REFUND] });
    // The fake repeats its last answer, so every save is stale and every get
    // returns the same unreadable draft.
    const save = fakeSave(STALE);
    // A newer page stored an edit kind this page does not know.
    const get = fakeGet({
      ok: true,
      draft: savedDraft({
        server: "stripe",
        serverId: STRIPE,
        ops: [{ kind: "rename", tool: "list_customers", to: "customers" }],
        revision: 3,
      }),
    });
    const open = fakeOpen({ ok: true, review: studioReview() });
    renderTab(STRIPE, { save: save.save, get: get.get, open: open.open });
    openSteeringPr();
    const kept = await screen.findByTestId("studio-pr-kept");
    expect(kept).toHaveAttribute("role", "alert");
    expect(kept.textContent).toBe(KEPT);
    expect(screen.queryByTestId("studio-pr-conflict")).toBeNull();
    // The edits stay at this tab's own revision. Taking revision 3 would let
    // the next save replace the whole list and delete the edits this page
    // cannot read.
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 1,
      ops: [IMPORT_REFUND],
    });
    expect(open.calls).toHaveLength(0);
    // A second Open sends the same revision, so it conflicts again and still
    // opens nothing. A reload is what brings a page able to merge.
    openSteeringPr();
    await waitFor(() => {
      expect(save.calls).toHaveLength(2);
    });
    expect(save.calls[1]).toStrictEqual({
      server: "stripe",
      serverId: STRIPE,
      ops: [IMPORT_REFUND],
      revision: 1,
    });
    expect(open.calls).toEqual([]);
    expect(screen.queryByTestId("studio-pr-opened")).toBeNull();
  });

  it("keeps its own revision when the stored draft holds more edits than a draft may", async () => {
    seedDraft(draftKey("stripe"), { revision: 1, ops: [IMPORT_REFUND] });
    const save = fakeSave(STALE);
    const get = fakeGet({
      ok: true,
      draft: savedDraft({
        server: "stripe",
        serverId: STRIPE,
        ops: Array.from({ length: 2_001 }, (_, n) => ({
          kind: "import",
          tool: `tool_${String(n)}`,
        })),
        revision: 3,
      }),
    });
    renderTab(STRIPE, { save: save.save, get: get.get });
    openSteeringPr();
    expect((await screen.findByTestId("studio-pr-kept")).textContent).toBe(
      KEPT,
    );
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 1,
      ops: [IMPORT_REFUND],
    });
  });
});

describe("ChangesTab save and Review failures", () => {
  it("shows a failed save and leaves the draft unsaved", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave({ ok: false, reason: "failed", code: "unavailable" });
    const get = fakeGet();
    const open = fakeOpen();
    renderTab(STRIPE, { save: save.save, get: get.get, open: open.open });
    openSteeringPr();
    const failed = await screen.findByTestId("studio-pr-failed");
    expect(failed).toHaveAttribute("role", "alert");
    expect(failed.textContent).toBe(UNAVAILABLE);
    expect(get.calls).toHaveLength(0);
    expect(open.calls).toHaveLength(0);
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 0,
      ops: [IMPORT_REFUND],
    });
  });

  it("names a refusal the page knows in its own words", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave({ ok: false, reason: "failed", code: "denied" });
    const open = fakeOpen();
    renderTab(STRIPE, { save: save.save, open: open.open });
    openSteeringPr();
    expect((await screen.findByTestId("studio-pr-failed")).textContent).toBe(
      "Only an organization owner or admin, or a workspace owner, can open a steering PR.",
    );
    expect(open.calls).toHaveLength(0);
  });

  it("tells the person to discard edits when the draft is too large to send", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave({ ok: false, reason: "failed", code: "too_large" });
    renderTab(STRIPE, { save: save.save });
    openSteeringPr();
    expect((await screen.findByTestId("studio-pr-failed")).textContent).toBe(
      "This draft is over the 960 KiB this page can send in one request. Discard some edits, then open the steering PR again. The Oxagen API and MCP tools save drafts up to 8 MiB.",
    );
  });

  it("names a refusal the page does not know by its code", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave({
      ok: false,
      reason: "failed",
      code: "draft_store_paused",
    });
    renderTab(STRIPE, { save: save.save });
    openSteeringPr();
    expect((await screen.findByTestId("studio-pr-failed")).textContent).toBe(
      "The steering PR did not open. Oxagen answered draft_store_paused.",
    );
  });

  it("shows a try-again failure when the save throws", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave();
    renderTab(STRIPE, { save: save.save });
    openSteeringPr();
    const failed = await screen.findByTestId("studio-pr-failed");
    expect(failed.textContent).toBe(THROWN);
    // The thrown message is the fake's, and the page never shows it.
    expect(failed).not.toHaveTextContent("the fake seam has no answer");
    expect(screen.getByTestId("studio-pr-open")).toHaveTextContent(
      "Open steering PR",
    );
  });

  it("shows the same try-again failure when the save throws a non-Error", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = vi.fn<SaveStudioDraft>().mockRejectedValue("storage full");
    renderTab(STRIPE, { save });
    openSteeringPr();
    const failed = await screen.findByTestId("studio-pr-failed");
    expect(failed.textContent).toBe(THROWN);
    expect(failed).not.toHaveTextContent("storage full");
  });

  it("stops before Review when the draft imports a tool and no definition is attached", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({
        server: "stripe",
        serverId: STRIPE,
        ops: [IMPORT_REFUND],
        revision: 1,
      }),
    });
    const open = fakeOpen();
    renderTab(STRIPE, { save: save.save, open: open.open });
    openSteeringPr();
    const note = await screen.findByTestId("studio-pr-source-missing");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveAttribute("data-gap", "#4678");
    expect(note).toHaveTextContent(SOURCE_MISSING);
    expect(open.calls).toHaveLength(0);
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 1,
      ops: [IMPORT_REFUND],
    });
  });

  it("always needs the definition for a gRPC server, even when nothing is imported", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({ ops: [CLASSIFY_REFUND], revision: 3 }),
    });
    const open = fakeOpen();
    renderTab(BILLING, {
      sourceType: "grpc",
      save: save.save,
      open: open.open,
    });
    openSteeringPr();
    expect(
      await screen.findByTestId("studio-pr-source-missing"),
    ).toHaveTextContent(SOURCE_MISSING);
    expect(open.calls).toHaveLength(0);
  });

  it("opens the steering PR for a gRPC server once its definition is attached", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({
        ops: [CLASSIFY_REFUND],
        source: { type: "grpc", bytes: 4_096 },
        revision: 3,
      }),
    });
    const open = fakeOpen({ ok: true, review: studioReview() });
    renderTab(BILLING, {
      sourceType: "grpc",
      save: save.save,
      open: open.open,
    });
    openSteeringPr();
    expect(await screen.findByTestId("studio-pr-opened")).toBeInTheDocument();
    expect(open.calls).toStrictEqual([{ server: "billing", revision: 3 }]);
  });

  it("keeps the saved draft and shows the failure when the steering PR does not open", async () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({
        server: "stripe",
        serverId: STRIPE,
        ops: [IMPORT_REFUND],
        source: { type: "mcp", bytes: 18_432 },
        revision: 1,
      }),
    });
    const open = fakeOpen({
      ok: false,
      reason: "failed",
      code: "production_branch_missing",
    });
    renderTab(STRIPE, { save: save.save, open: open.open });
    openSteeringPr();
    expect((await screen.findByTestId("studio-pr-failed")).textContent).toBe(
      "The steering repository has no production branch. Push one, then open the steering PR again.",
    );
    expect(open.calls).toStrictEqual([{ server: "stripe", revision: 1 }]);
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 1,
      ops: [IMPORT_REFUND],
    });
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Import create_refund",
    );
  });

  it("shows a Review refused after a clean save as a failure, without reloading the draft", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({ ops: [CLASSIFY_REFUND], revision: 3 }),
    });
    const get = fakeGet();
    const open = fakeOpen({
      ok: false,
      reason: "failed",
      code: "tools_unclassified",
    });
    renderTab(BILLING, { save: save.save, get: get.get, open: open.open });
    openSteeringPr();
    expect((await screen.findByTestId("studio-pr-failed")).textContent).toBe(
      "Every imported tool needs a risk, a side effect, and an egress. Classify each one, then open the steering PR again.",
    );
    expect(screen.queryByTestId("studio-pr-conflict")).toBeNull();
    expect(get.calls).toHaveLength(0);
    expect(save.calls).toHaveLength(1);
  });

  it("reloads the stored draft when Review finds someone saved after this tab did", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({ ops: [CLASSIFY_REFUND], revision: 3 }),
    });
    // Someone else saved between this tab's save and its Review.
    const get = fakeGet({
      ok: true,
      draft: savedDraft({ ops: [IMPORT_VOID], revision: 4 }),
    });
    const open = fakeOpen(STALE);
    renderTab(BILLING, { save: save.save, get: get.get, open: open.open });
    openSteeringPr();
    const alert = await screen.findByTestId("studio-pr-conflict");
    expect(alert.textContent).toBe(CONFLICT);
    expect(open.calls).toStrictEqual([{ server: "billing", revision: 3 }]);
    expect(get.calls).toStrictEqual([{ server: "billing" }]);
    expect(stored(draftKey("billing"))).toEqual({
      revision: 4,
      ops: [IMPORT_VOID, CLASSIFY_REFUND],
    });
    expect(save.calls).toHaveLength(1);
    expect(screen.queryByTestId("studio-pr-failed")).toBeNull();
  });

  it("shows a try-again failure and keeps the saved revision when opening throws", async () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [CLASSIFY_REFUND] });
    const save = fakeSave({
      ok: true,
      draft: savedDraft({ ops: [CLASSIFY_REFUND], revision: 3 }),
    });
    const open = fakeOpen();
    renderTab(BILLING, { save: save.save, open: open.open });
    openSteeringPr();
    expect((await screen.findByTestId("studio-pr-failed")).textContent).toBe(
      THROWN,
    );
    expect(stored(draftKey("billing"))).toEqual({
      revision: 3,
      ops: [CLASSIFY_REFUND],
    });
  });
});

describe("ChangesTab editing and folder", () => {
  it("shows the edits read-only to a person who cannot open a steering PR", () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    renderTab(STRIPE, { canEdit: false });
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Import create_refund",
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(
      screen.getByText(
        "Only an organization owner or admin can open a steering PR.",
      ),
    ).toBeInTheDocument();
  });

  it("removes one staged edit and keeps the rest", () => {
    seedDraft(draftKey("stripe"), {
      revision: 0,
      ops: [IMPORT_REFUND, REMOVE_CUSTOMERS],
    });
    renderTab(STRIPE);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove the edit to create_refund" }),
    );
    expect(screen.getByTestId("studio-edit-0")).toHaveTextContent(
      "Remove list_customers",
    );
    expect(screen.queryByTestId("studio-edit-1")).toBeNull();
    expect(screen.queryByTestId("studio-change-create_refund")).toBeNull();
    expect(stored(draftKey("stripe"))).toEqual({
      revision: 0,
      ops: [REMOVE_CUSTOMERS],
    });
  });

  it("discards a never-saved draft and drops it from the tab's storage", () => {
    seedDraft(draftKey("stripe"), { revision: 0, ops: [IMPORT_REFUND] });
    renderTab(STRIPE);
    fireEvent.click(screen.getByTestId("studio-draft-discard"));
    expect(screen.getByTestId("studio-changes-empty")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBeNull();
  });

  it("discards a saved draft's edits but keeps its revision, so the next save is not refused", () => {
    seedDraft(draftKey("stripe"), { revision: 4, ops: [IMPORT_REFUND] });
    renderTab(STRIPE);
    fireEvent.click(screen.getByTestId("studio-draft-discard"));
    expect(screen.getByTestId("studio-changes-empty")).toBeInTheDocument();
    expect(stored(draftKey("stripe"))).toEqual({ revision: 4, ops: [] });
  });

  it("keys the draft by registry id and keeps Open steering PR off while no steering folder is recorded", () => {
    seedDraft(idDraftKey(GITHUB), {
      revision: 0,
      ops: [{ kind: "remove", tool: "get_file_contents" }],
    });
    renderTab(GITHUB);
    // The registry holds no token count for GitHub's tool.
    expect(tokens()).toBe(tokenLine("not recorded", "0"));
    const row = screen.getByTestId("studio-change-get_file_contents");
    expect(row).toHaveAttribute("data-change", "removed");
    expect(within(row).getByText("not measured")).toBeInTheDocument();
    // With no record the paths are bare, and the tab says so.
    expect(files()).toEqual(["tools.toml", "tools.lock.json"]);
    const folder = screen.getByTestId("studio-folder-missing");
    expect(folder).toHaveAttribute("data-gap", "#4678");
    expect(folder).toHaveTextContent(
      "Oxagen has not recorded this server's steering folder yet, so the paths are the defaults.",
    );
    expect(screen.getByTestId("studio-pr-open")).toBeDisabled();
    const noServer = screen.getByTestId("studio-pr-no-server");
    expect(noServer).toHaveAttribute("data-gap", "#4678");
    expect(noServer).toHaveTextContent(
      "Oxagen has not recorded this server's steering folder yet, so a steering PR cannot be opened from here.",
    );
    expect(screen.getByTestId("studio-draft-discard")).toBeEnabled();
  });

  it("shows no folder note to a person who cannot open a steering PR", () => {
    seedDraft(idDraftKey(GITHUB), {
      revision: 0,
      ops: [{ kind: "remove", tool: "get_file_contents" }],
    });
    renderTab(GITHUB, { canEdit: false });
    expect(screen.queryByTestId("studio-pr-no-server")).toBeNull();
    expect(screen.getByTestId("studio-folder-missing")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only an organization owner or admin can open a steering PR.",
      ),
    ).toBeInTheDocument();
  });
});
