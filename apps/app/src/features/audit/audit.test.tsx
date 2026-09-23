// @vitest-environment jsdom
// The Audit page's body (rev1 audit.md) in each state a read can put it in:
// the record on Events with its tiles, filters, table and pager; an empty
// answer under filters; an empty record; a refusal; a pending access request;
// a failed read; and the skeleton. The five other tabs render their panels and
// name what is missing, and the dialogs open with the design's copy. What the
// record does not carry is asserted "not recorded", never a zero. axe checks
// the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditPage } from "@/data/contracts/audit";
import type { MemberList, WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Audit, AuditSkeleton } = await import("./audit");
const { AuditHeaderAction } = await import("./header-action");
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
const members = vi.fn<DataSource["org"]["members"]>();
const workspaces = vi.fn<DataSource["org"]["workspaces"]>();
const refuse = () => Promise.reject(new Error("not an Audit read"));
const source: DataSource = {
  pretenant: { orgs: refuse, workspaces: refuse },
  shell: { context: refuse, preferences },
  runs: {
    list: refuse,
    get: refuse,
    frameBody: refuse,
    cost: refuse,
    transcript: refuse,
    chain: refuse,
    outputs: refuse,
  },
  approvals: { pending: refuse, resolved: refuse },
  agents: {
    list: refuse,
    get: refuse,
    toolbelt: refuse,
    incidents: refuse,
  },
  billing: {
    plan: refuse,
    usageCredits: refuse,
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
    sso: refuse,
  },
  audit: { events, exportEvents },
  onboarding: { state: refuse, firstFrame: refuse },
  skills: { inventory: refuse, configuration: refuse },
  mandates: { list: refuse, get: refuse },
  steering: {
    records: refuse,
    record: refuse,
    proposals: refuse,
    contextPr: refuse,
    freshness: refuse,
    deliveries: refuse,
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
  events.mockImplementation(async (_ctx, q) => {
    if (q.limit === 200) return reads.window ?? recordOf([]);
    if (q.limit === 1) return reads.any ?? recordOf([]);
    return reads.page ?? reads.window ?? recordOf([]);
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

/** The table row whose Event cell reads `eventType`. */
function rowOf(eventType: string): HTMLElement {
  const found = within(screen.getByRole("table"))
    .getByText(eventType)
    .closest("tr");
  if (found === null) throw new Error(`no row for ${eventType}`);
  return found;
}

/** Each tile's term, value and basis line, in order. */
function tiles(): string[][] {
  const strip = screen.getAllByRole("definition").at(0)?.closest("dl");
  if (!strip) throw new Error("no tile strip");
  return [...strip.children].map((tile) =>
    [...tile.children].map((part) => part.textContent ?? ""),
  );
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  events.mockReset();
  preferences.mockReset();
  preferences.mockResolvedValue(readOk({ timeZone: "America/Los_Angeles" }));
  exportEvents.mockReset();
  members.mockReset();
  members.mockResolvedValue(roster);
  workspaces.mockReset();
  workspaces.mockResolvedValue(
    readOk<WorkspaceList>({
      workspaces: [
        {
          id: "ws_01K5ARCHIVED",
          slug: "old",
          name: "Old",
          role: "owner",
          archivedAt: "2026-01-01T00:00:00.000Z",
          costCenter: null,
        },
        {
          id: "ws_01K5CORE",
          slug: "core-platform",
          name: "Core platform",
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
        "Events · 30 days",
        "3",
        "every IAM decision is recorded, allowed or not",
      ],
      ["Denied", "2", "denials are recorded and cost nothing"],
      [
        "By a service principal",
        "not recorded",
        "Terraform, CI, exports, the archiver",
      ],
      [
        "By an agent",
        "not recorded",
        "each one a governed action with a receipt",
      ],
    ]);
    // The Events tab carries the same count the first tile does.
    expect(screen.getByRole("link", { name: /Events/ })).toHaveTextContent(
      "Events3",
    );
    expect(screen.getByRole("link", { name: /Events/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows a lower bound, never a total, when the window holds more than one read returns", async () => {
    answer({ window: recordOf([denied], { hasMore: true }) });
    await renderAudit();

    expect(tiles()[0]?.[1]).toBe("1+");
    expect(tiles()[1]?.[1]).toBe("1+");
    expect(screen.getByTestId("audit-shown")).toHaveTextContent(/^1-1$/);
  });

  it("names the tile after the Range the reader picked", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit({ range: "48h" });

    expect(tiles()[0]?.[0]).toBe("Events · 48 hours");
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
    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(first).toHaveTextContent("Ada Lovelace");
    expect(first).toHaveTextContent("kind not recorded");
    expect(first).toHaveTextContent("purchase_gau_bucket");
    expect(first).toHaveTextContent("req_01K5ABCDE");
    expect(first?.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-09-15T10:04:31.221Z",
    );
    // The result survives greyscale: a dot and a word.
    const outcome = first?.querySelector("[data-outcome]");
    expect(outcome).toHaveAttribute("data-outcome", "deny");
    expect(outcome).toHaveTextContent("denied");
    // A former member is printed by public id; a missing request says so.
    expect(second).toHaveTextContent(GONE);
    expect(
      within(second as HTMLElement).getAllByText("not recorded").length,
    ).toBe(2);
  });

  it("carries the panel's heading, caption, store badge and the note verbatim", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit();

    const panel = screen
      .getByRole("heading", { name: "Control-plane events" })
      .closest("section") as HTMLElement;
    expect(panel).toHaveTextContent(
      "admin actions, IAM changes, repo bindings, plane changes, key rotations",
    );
    expect(panel).toHaveTextContent("postgres · 7 years");
    expect(panel).toHaveTextContent(
      "The record is written by the kernel, never by an agent. A client-attested call is labeled as such and can never be shown as decided by Oxagen.",
    );
    expect(screen.getByTestId("audit-shown")).toHaveTextContent("1-1 of 1");
  });

  it("offers Actor, Range, Result and Rows, and disables Search and Severity, naming why", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit({ actor: ADA, outcome: "deny", rows: "25" });

    const actor = screen.getByRole("combobox", { name: "Actor" });
    expect(actor).toHaveValue(ADA);
    expect(
      within(actor)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["All actors", "Ada Lovelace"]);
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
    ).toEqual(["All · Result", "allowed", "denied"]);
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
    expect(screen.getByRole("combobox", { name: "Severity" })).toBeDisabled();

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

  it("links Newer and Older at the Rows size, keeping the filters", async () => {
    answer({
      window: recordOf([denied], { hasMore: true }),
      page: recordOf([denied], { hasMore: true, offset: 25, limit: 25 }),
    });
    await renderAudit({ outcome: "deny", rows: "25", offset: "25" });

    expect(screen.getByRole("link", { name: "Newer events" })).toHaveAttribute(
      "href",
      "/acme/audit?outcome=deny&rows=25",
    );
    expect(screen.getByRole("link", { name: "Older events" })).toHaveAttribute(
      "href",
      "/acme/audit?outcome=deny&rows=25&offset=50",
    );
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

  it("opens the CSV dialog with a download over the same filters", async () => {
    answer({ window: recordOf([denied]) });
    await renderAudit({ outcome: "deny", range: "7d" });

    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    const dialog = await screen.findByRole("dialog", { name: "Export events" });
    expect(dialog).toHaveTextContent(
      "CSV · the same rows the API and MCP return",
    );
    expect(
      within(dialog).getByRole("link", { name: "Download CSV" }),
    ).toHaveAttribute(
      "href",
      "/acme/audit/export?outcome=deny&range=7d&format=csv",
    );
  });
});

describe("tabs", () => {
  it("links the six tabs, each a segment, marking the current one", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "keys" });

    const nav = screen.getByRole("navigation", { name: "Audit sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Events1", "/acme/audit"],
      ["Incidents", "/acme/audit/incidents"],
      ["Receipts", "/acme/audit/receipts"],
      ["Exports", "/acme/audit/exports"],
      ["Keys", "/acme/audit/keys"],
      ["Retention", "/acme/audit/retention"],
    ]);
    expect(within(nav).getByRole("link", { name: "Keys" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Only Events reads a page of the table.
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["incidents", ["Incidents"], "Open an incident"],
    ["receipts", ["Receipt search"], null],
    ["exports", ["Exports", "Verifier", "Outbound events"], null],
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
      // Nothing on a tab with no store prints a figure.
      expect(document.body).not.toHaveTextContent(/\$\d/);
    },
  );

  it("fills the Incidents tiles with not recorded, never a zero", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "incidents" });

    expect(tiles().map(([term, value]) => [term, value])).toEqual([
      ["Open", "not recorded"],
      ["Critical · 12 months", "not recorded"],
      ["Median time to resolve", "not recorded"],
      ["Money moved without a receipt", "not recorded"],
    ]);
  });

  it("says what Redaction does, before write", async () => {
    answer({ window: recordOf([event()]) });
    await renderAudit({}, { tab: "retention" });

    const redaction = screen
      .getByRole("heading", { name: "Redaction" })
      .closest("section") as HTMLElement;
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
        within(dialog).getByTestId("audit-not-recorded").textContent ?? "",
      );
    },
  );
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
    expect(empty).not.toHaveAttribute("data-audit-failed");
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

  it("renders the error state with the code, Try again, Open an incident and the time it failed", async () => {
    events.mockResolvedValue(readError("audit_store_unavailable", 503));
    await renderAudit({}, { tab: "keys" });

    const error = screen.getByTestId("audit-error");
    expect(error).toHaveAttribute("data-audit-failed");
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
      "trace not recorded · region not recorded · 2026-09-16T12:00:00.000Z",
    );
  });

  it("renders the denied state with the permission, Request access and Back to Fleet", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    await renderAudit({}, { viewer: memberCtx });

    const denied = screen.getByTestId("audit-denied");
    expect(denied).toHaveAttribute("data-audit-failed");
    expect(denied).toHaveTextContent("You cannot see the audit record");
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include org.admin. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    const facts = [...denied.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(facts).toEqual([
      ["Signed in as", "member"],
      ["Needed", "org.admin"],
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
    const [strip, rows] = [...skeleton.children];
    expect(strip?.children).toHaveLength(4);
    expect(rows?.children).toHaveLength(8);
    expect(skeleton).not.toHaveTextContent(/\d/);
  });
});

describe("the header's gold action", () => {
  it("opens Export an evidence bundle with Build bundle disabled and the reason beside it", async () => {
    render(
      <IntlProvider>
        <AuditHeaderAction />
      </IntlProvider>,
    );
    const open = screen.getByRole("button", { name: "Export evidence bundle" });
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", {
      name: "Export an evidence bundle",
    });
    expect(dialog).toHaveTextContent(
      "segments, attestations, key ids, and the verifier",
    );
    for (const field of ["Scope", "From", "To", "Format"]) {
      expect(within(dialog).getByLabelText(field)).toBeDisabled();
    }
    expect(
      within(dialog).getByRole("button", { name: "Build bundle" }),
    ).toBeDisabled();
  });
});
