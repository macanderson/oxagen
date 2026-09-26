// @vitest-environment jsdom
// The Audit page's body (rev1 audit.md) in each state a read can put it in:
// the record on Events with its tiles, filters, table and pager; an empty
// answer under filters; an empty record; a refusal; a pending access request;
// a failed read; and the skeleton. The five other tabs render their panels and
// name what is missing, Retention prints the pinned body retention, Exports
// reads back the export Build bundle queued, and the dialogs open with the
// design's copy and a Cancel. What the record does not carry is asserted
// "not recorded", never a zero. axe checks the state each test ends in
// (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuditBundle,
  AuditEvent,
  AuditPage,
  AuditRetention,
} from "@/data/contracts/audit";
import type { MemberList, WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { nth } from "@/test/nth";
import { IntlProvider } from "@/test/intl";

const { getAuthUser, buildBundle, push, refresh } = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  buildBundle: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn(), getAuthUser }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("./actions", () => ({ buildBundle }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push, replace: vi.fn(), refresh }),
}));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Audit, AuditSkeleton, traceTime } = await import("./audit");
const { AuditHeaderAction } = await import("./header-action");
const { AuditRetentionLine } = await import("./retention");
type AuditTab = import("./tabs").AuditTab;

/** A member the roster names, and a former member it no longer does. */
const ADA = "usr_7k2m9q4x8r1t5v3w";
const GONE = "usr_0z9y8x7w6v5u4t3s";

const fields = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
};

const ctx = unsafeMint(OrgCtx, { ...fields, orgRole: "owner" });
const memberCtx = unsafeMint(OrgCtx, { ...fields, orgRole: "member" });

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  occurredAt: "2026-09-15T10:04:31.221Z",
  eventType: "capability.invoke_denied",
  actor: ADA,
  capability: "purchase_gau_bucket",
  outcome: "deny",
  workspace: "core-platform",
  ip: "203.0.113.7",
  userAgent: "oxagen-cli/1.4.0",
  request: "req_01K5ABCDE",
  ...over,
});

const recordOf = (
  rows: readonly AuditEvent[],
  over: Partial<AuditPage> = {},
): Read<AuditPage> =>
  readOk({ events: [...rows], hasMore: false, offset: 0, limit: 10, ...over });

const roster: Read<MemberList> = readOk({
  members: [
    {
      id: ADA,
      name: "Ada Lovelace",
      email: "ada@acme.test",
      role: "admin",
      joinedAt: "2026-01-04T09:00:00.000Z",
    },
  ],
  invitations: [],
});

const events = vi.fn<DataSource["audit"]["events"]>();
const preferences = vi.fn<DataSource["shell"]["preferences"]>();
const exportEvents = vi.fn<DataSource["audit"]["exportEvents"]>();
const retention = vi.fn<DataSource["audit"]["retention"]>();
const bundle = vi.fn<DataSource["audit"]["bundle"]>();
const members = vi.fn<DataSource["org"]["members"]>();
const workspaces = vi.fn<DataSource["org"]["workspaces"]>();
const refuse = () => Promise.reject(new Error("not an Audit read"));
const source: DataSource = {
  runtimes: { list: refuse, agents: refuse },
  conversations: { latest: refuse },
  pretenant: { orgs: refuse, workspaces: refuse },
  shell: {
    context: refuse,
    preferences,
    counts: refuse,
    notifications: refuse,
    assistantEngine: refuse,
  },
  runs: {
    list: refuse,
    get: refuse,
    frameBody: refuse,
    cost: refuse,
    turns: refuse,
    transcript: refuse,
    chain: refuse,
    outputs: refuse,
    work: refuse,
    outcomesSettings: refuse,
    issues: refuse,
    context: refuse,
    findings: refuse,
  },
  approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
  agents: {
    list: refuse,
    get: refuse,
    toolbelt: refuse,
    incidents: refuse,
  },
  billing: {
    plan: refuse,
    usageCredits: refuse,
    retention: refuse,
    bucket: refuse,
    contractRate: refuse,
    invoices: refuse,
  },
  spend: {
    byGroup: refuse,
    fleet: refuse,
    drill: refuse,
    waste: refuse,
    gatewayPolicy: refuse,
    budgets: refuse,
    findings: refuse,
    findingEvidence: refuse,
    priceBook: refuse,
    unpricedModels: refuse,
  },
  org: {
    members,
    roles: refuse,
    workspaces,
    apiKeys: refuse,
    costCenters: refuse,
    modelCredential: refuse,
    dataPlane: refuse,
    workspaceFacts: refuse,
    sso: refuse,
  },
  audit: { events, exportEvents, retention, bundle },
  onboarding: { state: refuse, firstFrame: refuse },
  skills: { inventory: refuse, configuration: refuse },
  mandates: { list: refuse, get: refuse },
  steering: {
    records: refuse,
    record: refuse,
    proposals: refuse,
    contextPr: refuse,
    freshness: refuse,
    hub: refuse,
    deliveries: refuse,
    memories: refuse,
    tree: refuse,
  },
  tools: {
    versions: refuse,
    grants: refuse,
    killSwitches: refuse,
    approvalRules: refuse,
    connections: refuse,
    mcpServers: refuse,
  },
};

/** A pinned seven-year policy, with the volume past the included year measured. */
const POLICY: AuditRetention = {
  includedMonths: 12,
  bodyRetentionDays: 2555,
  rate: { micros: "23000", currency: "USD" },
  storedGbBeyondIncluded: 41,
};

const EXPORT_ID = "3f1c2b7a-9d4e-4c1b-8a2f-5e6d7c8b9a01";

const queued = (over: Partial<AuditBundle> = {}): Read<AuditBundle> =>
  readOk({
    exportRef: EXPORT_ID,
    status: "processing",
    ready: false,
    completedAt: null,
    ...over,
  });

/** The instant the page reads at; the Range window ends here. */
const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const THIRTY_DAYS_AGO = "2026-08-17T12:00:00.000Z";

type Reads = {
  /** The Range window the tiles and tab count read (limit 200). */
  window?: Read<AuditPage>;
  /** The table's page (limit = Rows). */
  page?: Read<AuditPage>;
  /** The one-row probe that tells an empty record from an empty window. */
  any?: Read<AuditPage>;
};

/** Answers each of the page's audit reads by what it asked for. */
function answer(reads: Reads) {
  events.mockImplementation((_ctx, q) => {
    if (q.limit === 200) return Promise.resolve(reads.window ?? recordOf([]));
    if (q.limit === 1) return Promise.resolve(reads.any ?? recordOf([]));
    return Promise.resolve(reads.page ?? reads.window ?? recordOf([]));
  });
}

async function renderAudit(
  searchParams: Record<string, string | string[]> = {},
  {
    viewer = ctx,
    tab = "events",
  }: { viewer?: typeof ctx; tab?: AuditTab } = {},
) {
  const element = await Audit({ ctx: viewer, source, tab, searchParams });
  return render(<IntlProvider>{element}</IntlProvider>);
}

/** The element as the select it must be. */
function selectOf(element: HTMLElement): HTMLSelectElement {
  if (!(element instanceof HTMLSelectElement))
    throw new Error(`expected a select, found ${element.tagName}`);
  return element;
}

/** The section a heading titles. */
function sectionOf(heading: string): HTMLElement {
  const found = screen
    .getByRole("heading", { name: heading })
    .closest("section");
  if (found === null) throw new Error(`no section for ${heading}`);
  return found;
}

/** Each tile's term, value and basis line, in order. */
function tiles(): string[][] {
  const strip = screen.getAllByRole("definition").at(0)?.closest("dl");
  if (!strip) throw new Error("no tile strip");
  return [...strip.children].map((tile) =>
    [...tile.children].map((part) => part.textContent),
  );
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  events.mockReset();
  preferences.mockReset();
  preferences.mockResolvedValue(
    readOk({ timeZone: "America/Los_Angeles", enterToSubmit: false }),
  );
  exportEvents.mockReset();
  retention.mockReset();
  retention.mockResolvedValue(readOk(POLICY));
  bundle.mockReset();
  bundle.mockResolvedValue(queued());
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue({
    id: "usr_viewer",
    email: "sam@acme.test",
    name: "Sam Reyes",
    avatarUrl: null,
    emailVerified: true,
    twoFactorEnabled: false,
  });
  buildBundle.mockReset();
  push.mockReset();
  refresh.mockReset();
  members.mockReset();
  members.mockResolvedValue(roster);
  workspaces.mockReset();
  workspaces.mockResolvedValue(
    readOk<WorkspaceList>({
      orgId: "org_7k2m9q4x8r1t5v3w6y0z2a",
      orgAvatarUrl: null,
      workspaces: [
        {
          id: "ws_01K5ARCHIVED",
          slug: "old",
          namespace: "old",
          name: "Old",
          avatarUrl: null,
          role: "owner",
          archivedAt: "2026-01-01T00:00:00.000Z",
          costCenter: null,
        },
        {
          id: "ws_01K5CORE",
          slug: "core-platform",
          namespace: "core-platform",
          name: "Core platform",
          avatarUrl: null,
          role: "owner",
          archivedAt: null,
          costCenter: null,
        },
      ],
    }),
  );
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    vi.restoreAllMocks();
  }
});

describe("Events", () => {
  const allowed = event({
    eventType: "role.assigned",
    outcome: "allow",
    capability: "change_member_role",
    request: "req_01K5ALLOW",
  });
  const denied = event();

  it("reads the thirty-day window for the tiles and a page of ten for the table", async () => {
    answer({ window: recordOf([denied, allowed]) });
    await renderAudit();

    expect(events).toHaveBeenCalledWith(ctx, {
      eventType: null,
      outcome: null,
      actor: null,
      capability: null,
      since: THIRTY_DAYS_AGO,
      until: null,
      offset: 0,
      limit: 200,
    });
    expect(events).toHaveBeenCalledWith(ctx, {
      eventType: null,
      outcome: null,
      actor: null,
      capability: null,
      since: THIRTY_DAYS_AGO,
      until: null,
      offset: 0,
      limit: 10,
    });
    // No day is filtered, so the zone is not worth a read.
    expect(preferences).not.toHaveBeenCalled();
  });

  it("counts the tiles off the window's rows, and says the two actor-kind tiles are not recorded", async () => {
    answer({ window: recordOf([denied, allowed, event({ request: "r2" })]) });
    await renderAudit();

    expect(tiles()).toEqual([
      [
        "Events in 30 days",
        "3",
        "every allowed and denied IAM decision is recorded",
      ],
      ["Denied", "2", "denials are recorded and cost nothing"],
      [
        "By a service principal",
        "not recorded",
        "Terraform, CI, exports, the archiver",
      ],
      // No receipt store exists, so the agent tile carries no basis line
      // that would claim one.
      ["By an agent", "not recorded"],
    ]);
    expect(document.body).not.toHaveTextContent("with a receipt");
    // The Events tab carries the same count the first tile does.
    expect(screen.getByRole("tab", { name: /Events/ })).toHaveTextContent(
      "Events3",
    );
    expect(screen.getByRole("tab", { name: /Events/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows a lower bound, never a total, when the window holds more than one read returns", async () => {
    answer({ window: recordOf([denied], { hasMore: true }) });
    await renderAudit();

    expect(tiles()[0]?.[1]).toBe("1+");
    expect(tiles()[1]?.[1]).toBe("1+");
    expect(screen.getByTestId("audit-shown")).toHaveTextContent(/^1–1$/);
  });

  it("names the tile after the Range the reader picked", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit({ range: "48h" });

    expect(tiles()[0]?.[0]).toBe("Events in 48 hours");
    expect(events.mock.calls[0]?.[1]).toMatchObject({
      since: "2026-09-14T12:00:00.000Z",
    });
    expect(screen.getByRole("combobox", { name: "Range" })).toHaveValue("48h");
  });

  it("prints the design's columns, with the actor named, severity not recorded and the request as the reference", async () => {
    answer({
      window: recordOf([denied, event({ actor: GONE, request: null })]),
    });
    await renderAudit();

    const table = screen.getByRole("table", { name: "Control-plane events" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "When",
      "Event",
      "Actor",
      "What",
      "Result",
      "Severity",
      "Reference",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    const first = nth(rows, 0, "a first event row");
    const second = nth(rows, 1, "a second event row");
    expect(first).toHaveTextContent("Ada Lovelace");
    expect(first).toHaveTextContent("kind not recorded");
    expect(first).toHaveTextContent("purchase_gau_bucket");
    expect(first).toHaveTextContent("req_01K5ABCDE");
    expect(first.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-09-15T10:04:31.221Z",
    );
    // The result survives greyscale: a dot and a word.
    const outcome = first.querySelector("[data-outcome]");
    expect(outcome).toHaveAttribute("data-outcome", "deny");
    expect(outcome).toHaveTextContent("denied");
    // A former member is printed by public id; a missing request says so.
    expect(second).toHaveTextContent(GONE);
    expect(within(second).getAllByText("not recorded").length).toBe(2);
  });

  it("carries the panel's heading, caption, store badge and the note verbatim", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit();

    const panel = sectionOf("Control-plane events");
    expect(panel).toHaveTextContent(
      "admin actions, IAM changes, repo bindings, plane changes, key rotations",
    );
    expect(panel).toHaveTextContent("postgres for 7 years");
    expect(panel).toHaveTextContent(
      "The record is written by the kernel, never by an agent. A client-attested call is labeled as such and can never be shown as decided by Oxagen.",
    );
    expect(screen.getByTestId("audit-shown")).toHaveTextContent("1–1 of 1");
  });

  it("offers Actor by kind, Range, Result and Rows, and disables Search, Severity and the kinds, naming why", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit({ actor: ADA, outcome: "deny", rows: "25" });

    // The design's actor kinds, disabled until the record carries one; the
    // person a link named stays visible so the filter can be cleared.
    const actor = screen.getByRole("combobox", { name: "Actor" });
    expect(actor).toHaveValue(ADA);
    const options = within(actor).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "All actors",
      "Humans",
      "Agents",
      "Services",
      "Ada Lovelace",
    ]);
    expect(options.map((option) => option.matches(":disabled"))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(actor).toHaveAccessibleDescription(
      "An audit event records no actor kind yet, so Humans, Agents and Services cannot be picked.",
    );
    expect(
      within(screen.getByRole("combobox", { name: "Rows" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["5", "10", "25", "50"]);
    expect(
      within(screen.getByRole("combobox", { name: "Range" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Last 48 hours", "Last 7 days", "Last 30 days"]);
    const result = screen.getByRole("combobox", { name: "Result" });
    expect(result).toHaveValue("deny");
    expect(
      within(result)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["All results", "allowed", "denied"]);
    expect(screen.getByRole("combobox", { name: "Rows" })).toHaveValue("25");

    const search = screen.getByRole("searchbox", {
      name: "Search the audit record",
    });
    expect(search).toBeDisabled();
    expect(search).toHaveAttribute(
      "placeholder",
      "Search events, receipts, actors, external ids",
    );
    expect(search).toHaveAccessibleDescription(
      "Search is not recorded yet. The audit read takes no text query, so use the Actor, Range and Result filters.",
    );
    const severity = screen.getByRole("combobox", { name: "Severity" });
    expect(severity).toBeDisabled();
    expect([...selectOf(severity).options].map((o) => o.textContent)).toEqual([
      "All severities",
      "critical",
      "info",
      "warning",
    ]);
    // Every filter is a 44 px tap target with 16 px text on a phone (rev1
    // audit.md, Mobile); the house input alone is about 38 px tall.
    const filters = screen.getByTestId("audit-filters");
    for (const each of filters.querySelectorAll(
      "select, input:not([type=hidden])",
    )) {
      expect(each.className).toContain("max-md:min-h-11");
      expect(each.className).toContain("max-md:text-base");
    }

    // The table's page is narrowed by the result and sized by Rows; the
    // window the tiles count is not narrowed by the result.
    expect(events).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ outcome: "deny", actor: ADA, limit: 25 }),
    );
    expect(events).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ outcome: null, actor: ADA, limit: 200 }),
    );
  });

  it("draws the design's numbered pager when the window read holds every row", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      event({ request: `req_${String(i)}` }),
    );
    answer({
      window: recordOf(rows),
      page: recordOf(rows.slice(10, 20), { hasMore: true, offset: 10 }),
    });
    await renderAudit({ outcome: "deny", offset: "10" });

    const pager = screen.getByRole("navigation", {
      name: "Pages of the audit record",
    });
    expect(screen.getByTestId("audit-shown")).toHaveTextContent("11–20 of 30");
    expect(pager).toHaveTextContent("11–20 of 30‹123›");
    expect(
      within(pager).getByRole("link", { name: "Previous page" }),
    ).toHaveAttribute("href", "/acme/audit?outcome=deny");
    expect(within(pager).getByRole("link", { name: "2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(pager).getByRole("link", { name: "3" })).toHaveAttribute(
      "href",
      "/acme/audit?outcome=deny&offset=20",
    );
    expect(
      within(pager).getByRole("link", { name: "Next page" }),
    ).toHaveAttribute("href", "/acme/audit?outcome=deny&offset=20");
    // A 44 px tap target on a phone (rev1 audit.md, Mobile).
    expect(
      within(pager).getByRole("link", { name: "Next page" }).className,
    ).toContain("max-md:min-h-11");
  });

  it("folds a long record into 1 2 … 45, as the design draws it", async () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      event({ request: `req_${String(i)}` }),
    );
    answer({
      window: recordOf(rows),
      page: recordOf(rows.slice(0, 5), { hasMore: true, limit: 5 }),
    });
    await renderAudit({ rows: "5" });

    const pager = screen.getByRole("navigation", {
      name: "Pages of the audit record",
    });
    expect(pager).toHaveTextContent("1–5 of 200‹12…40›");
    expect(
      within(pager).getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(within(pager).getByRole("link", { name: "40" })).toHaveAttribute(
      "href",
      "/acme/audit?rows=5&offset=195",
    );
  });

  it("claims no last page when the window read did not hold every row (negative)", async () => {
    answer({
      window: recordOf([denied], { hasMore: true }),
      page: recordOf([denied], { hasMore: true, offset: 25, limit: 25 }),
    });
    await renderAudit({ outcome: "deny", rows: "25", offset: "25" });

    const pager = screen.getByRole("navigation", {
      name: "Pages of the audit record",
    });
    // Pages 1 and 2 are read, page 3 exists, and nothing past it is known.
    expect(pager).toHaveTextContent("26–26‹123…›");
    expect(
      within(pager).getByRole("link", { name: "Previous page" }),
    ).toHaveAttribute("href", "/acme/audit?outcome=deny&rows=25");
    expect(
      within(pager).getByRole("link", { name: "Next page" }),
    ).toHaveAttribute("href", "/acme/audit?outcome=deny&rows=25&offset=50");
    expect(document.body).not.toHaveTextContent("Older events");
  });

  it("applies a picked filter at once, but a keyboard step only on Enter or leaving the select", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit();
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => undefined);
    const range = screen.getByRole("combobox", { name: "Range" });

    // A pick from the open list (a click or a tap) applies.
    fireEvent.pointerDown(range);
    fireEvent.change(range, { target: { value: "7d" } });
    expect(submit).toHaveBeenCalledTimes(1);

    // An arrow key on the closed select steps the value and reloads nothing
    // (WCAG 3.2.2): the page keeps focus on the select.
    fireEvent.keyDown(range, { key: "ArrowDown" });
    fireEvent.change(range, { target: { value: "30d" } });
    expect(submit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(range, { key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(2);

    // A stepped value applies when focus leaves, and a clean blur does nothing.
    const result = screen.getByRole("combobox", { name: "Result" });
    fireEvent.keyDown(result, { key: "ArrowDown" });
    fireEvent.change(result, { target: { value: "deny" } });
    fireEvent.blur(result);
    expect(submit).toHaveBeenCalledTimes(3);
    fireEvent.blur(result);
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("opens an event's recorded facts from a 44 px summary on a phone", async () => {
    answer({
      window: recordOf([event({ detail: { rule: "auto-approve-reads" } })]),
    });
    await renderAudit({});

    const summary = screen.getByText("Recorded facts");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.className).toContain("max-md:min-h-11");
  });

  it("says so in the panel when the filters match nothing, rather than the empty record", async () => {
    answer({ window: recordOf([denied]), page: recordOf([]) });
    await renderAudit({ outcome: "allow" });

    expect(
      screen.getByText("No events in this window match these filters."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("audit-empty")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists the Actor kinds alone when no link names a person", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit();

    expect(
      within(screen.getByRole("combobox", { name: "Actor" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["All actors", "Humans", "Agents", "Services"]);
  });

  it("opens the CSV dialog with a download over the same filters", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit({ outcome: "deny", range: "7d" });

    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    const dialog = await screen.findByRole("dialog", { name: "Export events" });
    expect(dialog).toHaveTextContent(
      "CSV of the same rows the API and MCP return",
    );
    expect(
      within(dialog).getByRole("link", { name: "Download CSV" }),
    ).toHaveAttribute(
      "href",
      "/acme/audit/export?outcome=deny&range=7d&format=csv",
    );
    // The design's count sentence, off the window read through the result.
    expect(within(dialog).getByTestId("audit-csv-body")).toHaveTextContent(
      /^1 event in the last 7 days, with the event id, actor, capability, result, workspace, IP address, user agent and request id\./,
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    // The design's header close beside the title.
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toHaveAttribute("data-header-close");
  });

  it("counts the CSV as a lower bound when the window read did not hold every row (negative)", async () => {
    answer({
      window: recordOf([denied, allowed], { hasMore: true }),
    });
    await renderAudit();

    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    const dialog = await screen.findByRole("dialog", { name: "Export events" });
    expect(within(dialog).getByTestId("audit-csv-body")).toHaveTextContent(
      /^2\+ events in the last 30 days, with/,
    );
  });

  it("says not recorded for an event with no actor, capability or result, never a blank (negative)", async () => {
    answer({
      window: recordOf([
        event({ actor: null, capability: null, outcome: null }),
      ]),
    });
    await renderAudit();

    const table = screen.getByRole("table", { name: "Control-plane events" });
    const row = nth(within(table).getAllByRole("row").slice(1), 0, "the row");
    const cells = within(row).getAllByRole("cell");
    // Actor, What and Result each say not recorded; no outcome badge is drawn.
    expect(nth(cells, 2, "Actor")).toHaveTextContent(/^not recorded/);
    expect(nth(cells, 3, "What")).toHaveTextContent(/^not recorded/);
    expect(nth(cells, 4, "Result")).toHaveTextContent("not recorded");
    expect(row.querySelector("[data-outcome]")).toBeNull();
  });

  it("names the tile and the CSV after the chosen days when the reader typed From or To", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit({ from: "2026-09-01", to: "2026-09-10" });

    expect(tiles()[0]?.[0]).toBe("Events in chosen days");
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    const dialog = await screen.findByRole("dialog", { name: "Export events" });
    expect(within(dialog).getByTestId("audit-csv-body")).toHaveTextContent(
      /^1 event in the chosen days, with/,
    );
  });

  it("keeps an Actor filter for someone the roster no longer names, by public id", async () => {
    answer({ window: recordOf([event({ actor: GONE })]) });
    await renderAudit({ actor: GONE });

    const actor = selectOf(screen.getByRole("combobox", { name: "Actor" }));
    expect(actor.value).toBe(GONE);
    expect(actor.selectedOptions[0]?.textContent).toBe(GONE);
  });

  it("names the picked actor from the roster, and by email when they set no name", async () => {
    members.mockResolvedValue(
      readOk<MemberList>({
        members: [
          {
            id: ADA,
            name: null,
            email: "ada@acme.test",
            role: "admin",
            joinedAt: "2026-01-04T09:00:00.000Z",
          },
        ],
        invitations: [],
      }),
    );
    answer({ window: recordOf([denied]) });
    await renderAudit({ actor: ADA });

    const actor = selectOf(screen.getByRole("combobox", { name: "Actor" }));
    expect(actor.selectedOptions[0]?.textContent).toBe("ada@acme.test");
  });

  it("prints actors by public id when the roster read fails, and keeps the page (negative)", async () => {
    members.mockResolvedValue(readError("org_store_unavailable", 503));
    answer({ window: recordOf([denied]) });
    await renderAudit();

    const table = screen.getByRole("table", { name: "Control-plane events" });
    const row = nth(within(table).getAllByRole("row").slice(1), 0, "the row");
    expect(row).toHaveTextContent(ADA);
    expect(row).not.toHaveTextContent("Ada Lovelace");
  });

  it("offers no page past the last one read when the window is partial and the page is the end", async () => {
    answer({
      window: recordOf([denied], { hasMore: true }),
      page: recordOf([denied], { hasMore: false, offset: 25, limit: 25 }),
    });
    await renderAudit({ rows: "25", offset: "25" });

    const pager = screen.getByRole("navigation", {
      name: "Pages of the audit record",
    });
    expect(pager).toHaveTextContent("26–26‹12›");
    expect(within(pager).queryByRole("link", { name: "Next page" })).toBeNull();
  });
});

describe("tabs", () => {
  it("links the six tabs, each a segment, marking the current one", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "keys" });

    const nav = screen.getByRole("navigation", { name: "Audit sections" });
    // The design's tab semantics (audit.audit-prompt.md check 12): a tablist
    // of tabs with aria-selected, each still a link to its own segment.
    const list = within(nav).getByRole("tablist", { name: "Audit sections" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => [
          tab.textContent,
          tab.getAttribute("href"),
          tab.getAttribute("aria-selected"),
        ]),
    ).toEqual([
      ["Events1", "/acme/audit", "false"],
      ["Incidents", "/acme/audit/incidents", "false"],
      ["Receipts", "/acme/audit/receipts", "false"],
      ["Exports", "/acme/audit/exports", "false"],
      ["Keys", "/acme/audit/keys", "true"],
      ["Retention", "/acme/audit/retention", "false"],
    ]);
    expect(within(nav).getByRole("tab", { name: "Keys" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Only Events reads a page of the table.
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["incidents", ["Incidents"], "Open an incident"],
    ["receipts", ["Receipt search"], null],
    ["exports", ["Verifier", "Outbound events"], null],
    ["keys", ["Keys"], "Rotate KEK"],
    ["retention", ["Retention", "Archive tiers", "Redaction"], "Edit policy"],
  ] as const)(
    "draws %s with its panels and names what is not recorded",
    async (tab, headings, action) => {
      answer({ window: recordOf([event()]) });
      await renderAudit({}, { tab });

      expect(
        screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
      ).toEqual(headings);
      const missing = screen.getAllByTestId("audit-not-recorded");
      expect(missing.length).toBeGreaterThan(0);
      for (const each of missing) {
        expect(each.dataset.issue).toMatch(/^\d+$/);
      }
      if (action !== null) {
        expect(screen.getByRole("button", { name: action })).toBeEnabled();
      }
      // Nothing on a tab with no store prints a figure. Retention prints the
      // one it reads: the cold storage rate, the basis of that figure.
      if (tab !== "retention") {
        expect(document.body).not.toHaveTextContent(/\$\d/);
      }
    },
  );

  it("fills the Incidents tiles with not recorded, never a zero", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "incidents" });

    expect(tiles().map(([term, value]) => [term, value])).toEqual([
      ["Open", "not recorded"],
      ["Critical in 12 months", "not recorded"],
      ["Median time to resolve", "not recorded"],
      ["Money moved without a receipt", "not recorded"],
    ]);
  });

  it("draws the Receipts search, Search, the example chips and clear, disabled beside the missing store", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "receipts" });

    const why =
      "Receipts are not recorded yet. No store holds a signed receipt per tool call, so there is nothing to search.";
    const search = screen.getByRole("searchbox", { name: "Search receipts" });
    expect(search).toBeDisabled();
    expect(search).toHaveAttribute(
      "placeholder",
      "agent key, tool, external effect id, call digest, receipt id",
    );
    expect(search).toHaveAccessibleDescription(why);
    expect(search.className).toContain("max-md:min-h-11");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    const chips = within(screen.getByRole("list", { name: "Examples" }))
      .getAllByRole("button")
      .map((chip) => [chip.textContent, chip.matches(":disabled")]);
    expect(chips).toEqual([
      ["stripe", true],
      ["harness", true],
      ["observe", true],
      ["deny", true],
      ["agent key", true],
      ["external effect id", true],
      ["clear", true],
    ]);
    // A 44 px tap target on a phone, like every other button (rev1 audit.md, Mobile).
    expect(screen.getByRole("button", { name: "clear" }).className).toContain(
      "max-md:min-h-11",
    );
  });

  it("opens Exports on the design's callout, with no Exports heading", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "exports" });

    expect(document.body).toHaveTextContent(
      "An export is a verifiable bundle: archive segments, attestations, key ids, and a verifier script.",
    );
    expect(screen.queryByRole("heading", { name: "Exports" })).toBeNull();
    // A signed per-run bundle exists (export_run), so nothing says no bundle
    // is built at all: the missing piece is the organization's.
    expect(document.body).toHaveTextContent(
      "A signed evidence bundle with its verifier is built per run today, not for the organization.",
    );
    expect(document.body).not.toHaveTextContent(
      "does not build evidence bundles",
    );
    // The callout describes the signed evidence bundle, so it follows the
    // sentence that says the organization has none yet.
    const gap = screen
      .getAllByTestId("audit-not-recorded")
      .find((p) => p.textContent.startsWith("No store lists"));
    const callout = screen.getByTestId("audit-exports-callout");
    if (gap === undefined) throw new Error("no exports gap sentence");
    expect(
      gap.compareDocumentPosition(callout) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(bundle).not.toHaveBeenCalled();
  });

  it("reads back the export Build bundle queued and offers its download once ready", async () => {
    answer({ window: recordOf([event()]) });
    bundle.mockResolvedValue(
      queued({
        status: "ready",
        ready: true,
        completedAt: "2026-09-16T11:58:00.000Z",
      }),
    );
    await renderAudit({ export: EXPORT_ID }, { tab: "exports" });

    expect(bundle).toHaveBeenCalledWith(ctx, EXPORT_ID);
    const card = screen.getByTestId("audit-bundle");
    expect(
      within(card).getByRole("heading", {
        name: "Organization data export (ZIP)",
      }),
    ).toBeInTheDocument();
    expect(card.querySelector("[data-status]")).toHaveTextContent("ready");
    const download = within(card).getByRole("link", { name: "Download" });
    expect(download).toHaveAttribute(
      "href",
      `/acme/account/export/${EXPORT_ID}`,
    );
    // The header's Export evidence bundle is the screen's one gold action.
    expect(download.className).not.toContain("bg-button-primary-bg");
    expect(
      within(card).getByRole("button", { name: "Verify bundle" }),
    ).toBeDisabled();
    const facts = [...card.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(facts).toEqual([
      ["Export id", EXPORT_ID],
      ["Range", "not recorded"],
      ["Contents", "the organization's data, one ZIP"],
      ["Size", "not recorded"],
      ["Created", "not recorded"],
      ["Completed", expect.stringContaining("2026")],
      ["Signature", "not recorded"],
      ["Key ids", "not recorded"],
    ]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("marks a building export as building, with no download yet", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({ export: EXPORT_ID }, { tab: "exports" });

    const card = screen.getByTestId("audit-bundle");
    expect(card.querySelector("[data-status]")).toHaveTextContent("building");
    expect(within(card).queryByRole("link", { name: "Download" })).toBeNull();
  });

  it("reads no export for an id that is not one, and says so when the read is refused (negative)", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({ export: "../../etc" }, { tab: "exports" });
    expect(bundle).not.toHaveBeenCalled();
    cleanup();

    bundle.mockResolvedValue(readError("not_found", 404));
    await renderAudit({ export: EXPORT_ID }, { tab: "exports" });
    expect(screen.getByTestId("audit-bundle-unread")).toHaveTextContent(
      `Export ${EXPORT_ID} could not be read. The control plane answered not_found.`,
    );
    cleanup();

    // A refusal names its reason where a failed read names its code.
    bundle.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.owner or org.admin",
    });
    await renderAudit({ export: EXPORT_ID }, { tab: "exports" });
    expect(screen.getByTestId("audit-bundle-unread")).toHaveTextContent(
      `Export ${EXPORT_ID} could not be read. The control plane answered denied.`,
    );
  });

  it("reads Exports again every five seconds while the export builds, and stops once the card is gone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      answer({ window: recordOf([event()]) });
      await renderAudit({ export: EXPORT_ID }, { tab: "exports" });
      expect(refresh).not.toHaveBeenCalled();

      vi.advanceTimersByTime(4_999);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      expect(refresh).toHaveBeenCalledTimes(2);

      cleanup();
      vi.advanceTimersByTime(15_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints a retention that is not whole years in days", async () => {
    answer({ window: recordOf([event()]) });
    retention.mockResolvedValue(readOk({ ...POLICY, bodyRetentionDays: 90 }));
    await renderAudit({}, { tab: "retention" });

    const body = [...sectionOf("Retention").querySelectorAll("dt")].find(
      (dt) => dt.textContent === "Body retention",
    );
    expect(body?.nextElementSibling).toHaveTextContent("90 days from the seal");
  });

  it("prints the pinned body retention and the measured cold volume at its rate", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "retention" });

    const policy = sectionOf("Retention");
    expect(policy).toHaveTextContent("organization policy");
    const fields = [...policy.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(fields).toEqual([
      ["Body retention", "7 years from the seal"],
      ["Hot window", "not recorded"],
      ["Replay of a compacted run", "not recorded"],
      ["Workspace opt-down", "not recorded"],
      [
        "Cold storage cost",
        "41 GB held past the included 12 months · $0.023 per GB-month",
      ],
    ]);
  });

  it("says not recorded for a policy nobody pinned, and unread with the code for a read that did not answer (negative)", async () => {
    answer({ window: recordOf([event()]) });
    retention.mockResolvedValue(
      readOk({
        ...POLICY,
        bodyRetentionDays: null,
        storedGbBeyondIncluded: null,
      }),
    );
    await renderAudit({}, { tab: "retention" });
    const values = () =>
      [...sectionOf("Retention").querySelectorAll("dd")].map(
        (dd) => dd.textContent,
      );
    expect(values()).toEqual(Array(5).fill("not recorded"));
    cleanup();

    retention.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.owner or org.admin",
    });
    await renderAudit({}, { tab: "retention" });
    // Body retention and Cold storage cost come from the read; the other three
    // have no read at all.
    expect(values()).toEqual([
      "unread (denied)",
      "not recorded",
      "not recorded",
      "not recorded",
      "unread (denied)",
    ]);
    // A refused retention read does not refuse the page.
    expect(screen.queryByTestId("audit-denied")).toBeNull();
    cleanup();

    retention.mockResolvedValue(readError("evidence_store_unavailable", 503));
    await renderAudit({}, { tab: "retention" });
    expect(values()).toEqual([
      "unread (evidence_store_unavailable)",
      "not recorded",
      "not recorded",
      "not recorded",
      "unread (evidence_store_unavailable)",
    ]);
  });

  it.each([
    [readOk(POLICY), "bodies 7 years"],
    [readOk({ ...POLICY, bodyRetentionDays: null }), "bodies not recorded"],
    [
      readError("evidence_store_unavailable", 503),
      "bodies unread (evidence_store_unavailable)",
    ],
  ] as const)(
    "prints the header's bodies segment from the retention read (%#)",
    async (read, segment) => {
      retention.mockResolvedValue(read);
      const element = await AuditRetentionLine({ ctx, source });
      render(<IntlProvider>{element}</IntlProvider>);
      const line = screen.getByTestId("audit-retention-line");
      expect(line).toHaveTextContent(
        `control-plane events retained 7 years · run ledger not recorded · ${segment} · acme`,
      );
    },
  );

  it("says what Redaction does, before write", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "retention" });

    const redaction = sectionOf("Redaction");
    expect(redaction).toHaveTextContent("before write");
    expect(redaction).toHaveTextContent(
      "The collector redacts credential shapes before a frame body is written.",
    );
  });

  it.each([
    ["incidents", "Open an incident", "Open an incident", "Raise it"],
    ["keys", "Rotate KEK", "Rotate the key-encryption key", "Rotate"],
    ["retention", "Edit policy", "Retention policy", "Save policy"],
  ] as const)(
    "on %s, %s opens its dialog with the submit disabled and the reason beside it",
    async (tab, button, title, submit) => {
      answer({ window: recordOf([event()]) });
      await renderAudit({}, { tab });

      fireEvent.click(screen.getByRole("button", { name: button }));
      const dialog = await screen.findByRole("dialog", { name: title });
      const go = within(dialog).getByRole("button", { name: submit });
      expect(go).toBeDisabled();
      expect(go).toHaveAccessibleDescription(
        within(dialog).getByTestId("audit-not-recorded").textContent,
      );
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      // The design's header close, the one control named Close.
      expect(
        within(dialog).getByRole("button", { name: "Close" }),
      ).toHaveAttribute("data-header-close");
      // Every field is a 44 px tap target with 16 px text on a phone (audit.md, Mobile).
      for (const each of dialog.querySelectorAll("input, select, textarea")) {
        expect(each.className).toContain("max-md:min-h-11");
        expect(each.className).toContain("max-md:text-base");
      }
    },
  );

  it.each([
    "events",
    "incidents",
    "receipts",
    "exports",
    "keys",
    "retention",
  ] as const)(
    "on %s, no heading, tile, badge or option carries a mid-dot, a comma or a not/never contrast",
    async (tab) => {
      answer({ window: recordOf([event()]) });
      await renderAudit({}, { tab });

      // The house rule the spec repeats (rev1 audit.md): a label is a plain noun.
      const labels = [
        ...screen.getAllByRole("heading"),
        ...document.querySelectorAll("dt, option, th"),
      ].map((each) => each.textContent);
      expect(labels.length).toBeGreaterThan(0);
      for (const text of labels) {
        expect(text).not.toMatch(/·|,|\b(not|never)\b/);
      }
    },
  );

  it("names no store on Keys while nothing records the keys (negative)", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "keys" });

    const keys = sectionOf("Keys");
    expect(keys).toHaveTextContent("Keys are not recorded yet.");
    expect(keys).not.toHaveTextContent("kms + postgres");
  });

  it("lists the six facts of a rotation, the new generation not recorded", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "keys" });

    fireEvent.click(screen.getByRole("button", { name: "Rotate KEK" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Rotate the key-encryption key",
    });
    expect(
      [...dialog.querySelectorAll("dt")].map((dt) => dt.textContent),
    ).toEqual([
      "New generation",
      "Takes effect",
      "Old generation",
      "Re-wrap",
      "Receipts",
      "Recorded as",
    ]);
    expect(dialog.querySelector("dd")).toHaveTextContent("not recorded");
    expect(dialog).toHaveTextContent(
      "key.rotated with who, when and the generation",
    );
  });

  it("fills the policy dialog from the pinned policy, with no typed default", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "retention" });

    fireEvent.click(screen.getByRole("button", { name: "Edit policy" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Retention policy",
    });
    expect(within(dialog).getByLabelText("Body retention")).toHaveTextContent(
      "7 years from the seal",
    );
    expect(within(dialog).getByLabelText("Frame hot window")).toHaveTextContent(
      "not recorded",
    );
    expect(dialog).not.toHaveTextContent("(default)");
    expect(dialog).toHaveTextContent(
      "Shortening the hot window compacts frame rows sooner and saves database cost.",
    );
  });
});

describe("states", () => {
  it("renders the empty state only when the record holds no event at all", async () => {
    answer({ window: recordOf([]), any: recordOf([]) });
    await renderAudit();

    const empty = screen.getByTestId("audit-empty");
    expect(empty).toHaveTextContent("No audit events yet");
    expect(empty).toHaveTextContent(
      "Control-plane audit events are written by the kernel on every governed action. An empty record means nothing has been done in this organization yet, not that recording is off.",
    );
    expect(
      within(empty).getByRole("link", { name: "Open Organization" }),
    ).toHaveAttribute("href", "/acme");
    // The state is shown alone: the header steps out of view.
    expect(empty).toHaveAttribute("data-audit-state", "empty");
    expect(empty.querySelector("[data-state-icon] svg")).not.toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Audit sections" }),
    ).toBeNull();
  });

  it("keeps the page when the window is empty but older events exist (negative)", async () => {
    answer({ window: recordOf([]), any: recordOf([event()]) });
    await renderAudit();

    expect(screen.queryByTestId("audit-empty")).toBeNull();
    expect(tiles()[0]?.[1]).toBe("0");
  });

  it("prints the error line's time as the design does", () => {
    expect(traceTime(Date.parse("2026-09-11T09:16:04.123Z"))).toBe(
      "2026-09-11 09:16:04Z",
    );
  });

  it("renders the error state with the code, Try again, Open an incident and the time it failed", async () => {
    events.mockResolvedValue(readError("audit_store_unavailable", 503));
    await renderAudit({}, { tab: "keys" });

    const error = screen.getByTestId("audit-error");
    expect(error).toHaveAttribute("data-audit-state", "error");
    expect(error.querySelector("[data-state-icon] svg")).not.toBeNull();
    expect(error).toHaveTextContent("Audit could not be loaded");
    expect(error).toHaveTextContent(
      "The control plane answered 503 audit_store_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/acme/audit/keys");
    expect(
      within(error).getByRole("button", { name: "Open an incident" }),
    ).toBeInTheDocument();
    expect(error).toHaveTextContent(
      "trace not recorded · region not recorded · 2026-09-16 12:00:00Z",
    );
    // Side by side on a phone too, as the design keeps them (rev1 audit.md, Mobile).
    const row = within(error).getByRole("link", {
      name: "Try again",
    }).parentElement;
    expect(row?.className).not.toContain("max-md:flex-col");
    expect(row?.className).not.toContain("max-md:w-full");
  });

  it("keeps the query on Try again", async () => {
    events.mockResolvedValue(readError("audit_store_unavailable", 503));
    await renderAudit({ outcome: "deny", range: "7d", rows: "25" });

    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/acme/audit?outcome=deny&range=7d&rows=25",
    );
    cleanup();

    await renderAudit({ export: EXPORT_ID }, { tab: "exports" });
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      `/acme/audit/exports?export=${EXPORT_ID}`,
    );
  });

  it("renders the denied state with the permission, Request access and Back to Fleet", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: PAGE_FAILURES.audit.permission,
    });
    await renderAudit({}, { viewer: memberCtx });

    const denied = screen.getByTestId("audit-denied");
    expect(denied).toHaveAttribute("data-audit-state", "denied");
    expect(denied.querySelector("[data-state-icon] svg")).not.toBeNull();
    expect(denied).toHaveTextContent("You cannot see the audit record");
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include org.owner or org.admin. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    const facts = [...denied.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(facts).toEqual([
      ["Signed in as", "Sam Reyes · org.member · acme"],
      ["Needed", "org.owner or org.admin"],
      ["Decided by", "not recorded"],
    ]);

    fireEvent.click(
      within(denied).getByRole("button", { name: "Request access" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Request access",
    });
    expect(
      within(dialog).getByRole("button", { name: "Send the request" }),
    ).toBeDisabled();
    expect(dialog).toHaveTextContent(
      "Granting a role is a governed action. It will appear in the audit record with the granter’s name, your name, and this reason.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toHaveAttribute("data-header-close");
    expect(within(dialog).getByTestId("audit-not-recorded").dataset.issue).toBe(
      "3820",
    );
  });

  it("sends a denied reader with no workspace to Organization instead (negative)", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    workspaces.mockResolvedValue(readError("workspace_list_unavailable", 503));
    await renderAudit({}, { viewer: memberCtx });

    expect(
      screen.getByRole("link", { name: "Open Organization" }),
    ).toHaveAttribute("href", "/acme");
    expect(screen.queryByRole("link", { name: "Back to Fleet" })).toBeNull();
  });

  it("renders a pending access request as waiting, not refused", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "areq_01K5",
    });
    await renderAudit();

    expect(screen.getByTestId("audit-pending")).toHaveTextContent(
      "Access request areq_01K5 is waiting for an owner's decision.",
    );
    expect(getAuthUser).not.toHaveBeenCalled();
  });

  it("names a viewer with no display name by their email when denied (negative)", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    getAuthUser.mockResolvedValue({
      id: "usr_viewer",
      email: "sam@acme.test",
      name: "",
      avatarUrl: null,
      emailVerified: true,
      twoFactorEnabled: false,
    });
    await renderAudit({}, { viewer: memberCtx });

    expect(screen.getByTestId("audit-denied")).toHaveTextContent(
      "sam@acme.test · org.member · acme",
    );
  });

  it("renders a failed page read as the error state even when the window answered (negative)", async () => {
    answer({
      window: recordOf([event()]),
      page: readError("record_unmappable", 502),
    });
    await renderAudit();

    expect(screen.getByTestId("audit-error")).toHaveTextContent(
      "502 record_unmappable",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("draws the skeleton with four tile blocks and a panel of seven rows, and no figure", () => {
    render(
      <IntlProvider>
        <AuditSkeleton />
      </IntlProvider>,
    );
    const skeleton = screen.getByRole("region", {
      name: "Loading the audit record",
    });
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton).toHaveAttribute("data-audit-state", "loading");
    const [strip, rows] = [...skeleton.children];
    expect(strip?.children).toHaveLength(4);
    expect(rows?.children).toHaveLength(8);
    expect(skeleton).not.toHaveTextContent(/\d/);
    // Every bone is the design's shimmer, as on every other page, and none pulses.
    expect(skeleton.querySelectorAll(".skeleton")).toHaveLength(12);
    expect(skeleton.querySelector(".animate-pulse")).toBeNull();
  });

  it("draws the denied state's lock in the denied tone, not the failed one", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: PAGE_FAILURES.audit.permission,
    });
    await renderAudit({}, { viewer: memberCtx });

    const icon = screen
      .getByTestId("audit-denied")
      .querySelector("[data-state-icon]");
    expect(icon).toHaveAttribute("data-state-icon", "denied");
    expect(icon).toHaveClass("border-warning/40", "text-warning");
    expect(icon?.className).not.toMatch(/destructive|error/);
  });
});

describe("the header's gold action", () => {
  async function openBundle() {
    render(
      <IntlProvider>
        <AuditHeaderAction org="acme" />
      </IntlProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export evidence bundle" }),
    );
    return screen.findByRole("dialog", { name: "Export an evidence bundle" });
  }

  it("opens Export an evidence bundle with Scope, the disabled range and format, the callout and Build bundle", async () => {
    const dialog = await openBundle();
    expect(dialog).toHaveTextContent("The organization's data as one ZIP");
    expect(dialog).not.toHaveTextContent(
      "segments, attestations, key ids, and the verifier",
    );
    expect(within(dialog).getByLabelText("Scope")).toBeEnabled();
    // The ZIP export_data builds is the selected format; the design's three
    // formats stay listed and disabled until the signed bundle exists (#3876).
    const format = selectOf(within(dialog).getByLabelText("Format"));
    expect(format.value).toBe("zip");
    expect(
      [...format.options].map((option) => [option.text, option.disabled]),
    ).toEqual([
      ["Organization ZIP", false],
      ["Signed bundle (segments + verifier)", true],
      ["Receipts as CSV", true],
      ["Receipts as JSON", true],
    ]);
    for (const field of ["From", "To", "Format"]) {
      expect(within(dialog).getByLabelText(field)).toBeDisabled();
    }
    // From and To stack full width on a phone and pair up on a desktop.
    const dates = within(dialog)
      .getByLabelText("From")
      .closest("label")?.parentElement;
    if (dates == null) throw new Error("no From and To row");
    expect(dates.className).toContain("grid-cols-1");
    expect(dates.className).toContain("md:grid-cols-2");
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toHaveAttribute("data-header-close");
    expect(dialog).toHaveTextContent(
      "Runs as export_data, a governed action with third-party egress.",
    );
    // The ZIP is not the signed segment bundle, and the dialog says so.
    expect(within(dialog).getByTestId("audit-not-recorded").dataset.issue).toBe(
      "3876",
    );
    expect(
      within(dialog).getByRole("button", { name: "Build bundle" }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
  });

  it("queues export_data for the organization and opens Exports on the export", async () => {
    buildBundle.mockResolvedValue({ ok: true, value: { exportId: EXPORT_ID } });
    const dialog = await openBundle();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Build bundle" }),
    );
    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        `/acme/audit/exports?export=${EXPORT_ID}`,
      );
    });
    expect(buildBundle).toHaveBeenCalledWith("acme");
  });

  it("says why when the export is refused, and queues nothing (negative)", async () => {
    buildBundle.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    const dialog = await openBundle();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Build bundle" }),
    );
    expect(
      await within(dialog).findByTestId("audit-bundle-failure"),
    ).toHaveTextContent(
      "Only an organization owner or admin can export the organization. Nothing was queued.",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("names the access request an export waits on, and the code of a write that failed (negative)", async () => {
    buildBundle.mockResolvedValueOnce({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "ar_01K5WAIT",
    });
    const dialog = await openBundle();
    // The failure line can land before the transition settles, so each press
    // waits for the button to read "Build bundle" again rather than pressing
    // the pending one.
    const build = async () =>
      fireEvent.click(
        await within(dialog).findByRole("button", { name: "Build bundle" }),
      );

    await build();
    expect(
      await within(dialog).findByTestId("audit-bundle-failure"),
    ).toHaveTextContent("The export waits on access request ar_01K5WAIT.");

    buildBundle.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "export_queue_unavailable",
    });
    await build();
    await vi.waitFor(() => {
      expect(
        within(dialog).getByTestId("audit-bundle-failure"),
      ).toHaveTextContent(
        "The export was not queued. The control plane answered export_queue_unavailable.",
      );
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("queues one export when Build bundle is pressed again while the first is pending", async () => {
    buildBundle.mockReturnValue(new Promise(() => undefined));
    const dialog = await openBundle();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Build bundle" }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Queuing the export" }),
    );
    expect(buildBundle).toHaveBeenCalledTimes(1);
  });
});
