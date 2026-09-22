// @vitest-environment jsdom
// The Audit page's section in each state a read can put it in: the record, an
// empty record, an empty answer under filters, a refusal, a pending access
// request and a failed read, plus the skeleton the page shows while the record
// is read. What the record does not carry is asserted absent rather than blank:
// no tiles, no severity, no reference column. axe checks the state each test
// ends in (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditPage } from "@/data/contracts/audit";
import type { MemberList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Audit, AuditSkeleton } = await import("./audit");

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
  readOk({ events: [...rows], hasMore: false, offset: 0, limit: 50, ...over });

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
    workspaces: refuse,
    apiKeys: refuse,
    modelCredential: refuse,
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

async function renderAudit(
  searchParams: Record<string, string | string[]> = {},
  viewer = ctx,
) {
  const element = await Audit({ ctx: viewer, source, searchParams });
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

function at(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

beforeEach(() => {
  events.mockReset();
  preferences.mockReset();
  preferences.mockResolvedValue(readOk({ timeZone: "America/Los_Angeles" }));
  exportEvents.mockReset();
  members.mockReset();
  members.mockResolvedValue(roster);
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the record", () => {
  it("prints when, what, who, the capability and the result, naming the actor the roster knows", async () => {
    events.mockResolvedValue(recordOf([event()]));
    await renderAudit();

    expect(events).toHaveBeenCalledExactlyOnceWith(ctx, {
      eventType: null,
      outcome: null,
      actor: null,
      capability: null,
      since: null,
      until: null,
      offset: 0,
    });
    // No day is filtered, so the zone is not worth a read.
    expect(preferences).not.toHaveBeenCalled();
    const table = screen.getByRole("table", { name: "Control-plane events" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["When", "Event", "Actor", "What", "Result", "Details"]);

    const denied = rowOf("capability.invoke_denied");
    expect(denied).toHaveTextContent("Ada Lovelace");
    expect(denied).toHaveTextContent("purchase_gau_bucket");
    expect(denied.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-09-15T10:04:31.221Z",
    );
    // The result survives greyscale: the dot is decoration, the word is the answer.
    const outcome = denied.querySelector("[data-outcome]");
    expect(outcome).toHaveAttribute("data-outcome", "deny");
    expect(outcome).toHaveTextContent("denied");
  });

  it("opens the workspace, address, request and client the event recorded", async () => {
    events.mockResolvedValue(recordOf([event()]));
    await renderAudit();
    const details = rowOf("capability.invoke_denied").querySelector("details");
    expect(details).toHaveTextContent("core-platform");
    expect(details).toHaveTextContent("203.0.113.7");
    expect(details).toHaveTextContent("req_01K5ABCDE");
    expect(details).toHaveTextContent("oxagen-cli/1.4.0");
  });

  it("shows recorded invalidation facts as escaped text", async () => {
    const detail = {
      ruleId: "rule_123",
      reason: "tool_version_changed",
      before: { name: "<script>alert(1)</script>" },
      after: { name: "updated" },
    };
    events.mockResolvedValue(
      recordOf([event({ eventType: "approval_rule.invalidated", detail })]),
    );
    await renderAudit();
    const details = rowOf("approval_rule.invalidated").querySelector("details");
    expect(details).toHaveTextContent("Recorded facts");
    expect(details?.querySelector("pre")?.textContent).toBe(
      JSON.stringify(detail, null, 2),
    );
    expect(details?.querySelector("script")).toBeNull();
  });

  it("prints the id of an actor who is no longer a member, rather than nothing", async () => {
    events.mockResolvedValue(recordOf([event({ actor: GONE })]));
    await renderAudit();
    expect(rowOf("capability.invoke_denied")).toHaveTextContent(GONE);
  });

  it("says a field the record did not fill is not recorded, and invents no value for it (negative)", async () => {
    events.mockResolvedValue(
      recordOf([
        event({
          eventType: "auth.session_expired",
          actor: null,
          capability: null,
          outcome: null,
          workspace: null,
          ip: null,
          userAgent: null,
          request: null,
        }),
      ]),
    );
    await renderAudit();
    const expired = rowOf("auth.session_expired");
    expect(
      within(expired).getAllByText("not recorded").length,
    ).toBeGreaterThanOrEqual(3);
    expect(expired.querySelector("[data-outcome]")).toBeNull();
  });

  it("draws nothing the record does not carry: no tiles, no severity, no reference (negative)", async () => {
    events.mockResolvedValue(recordOf([event()]));
    await renderAudit();
    for (const absent of [/severity/i, /reference/i, /service principal/i])
      expect(screen.queryByText(absent)).toBeNull();
    expect(screen.queryAllByRole("meter")).toHaveLength(0);
    expect(
      within(screen.getByRole("table")).getAllByRole("columnheader"),
    ).toHaveLength(6);
  });
});

describe("filters and paging", () => {
  it("sends the filters the URL carries and keeps them on the export links", async () => {
    events.mockResolvedValue(recordOf([event()]));
    await renderAudit({ outcome: "deny", capability: "purchase_gau_bucket" });

    expect(events.mock.calls[0]?.[1]).toMatchObject({
      outcome: "deny",
      capability: "purchase_gau_bucket",
      offset: 0,
    });
    expect(at("[data-export=csv]")).toHaveAttribute(
      "href",
      "/acme/audit/export?outcome=deny&capability=purchase_gau_bucket&format=csv",
    );
    expect(at("[data-export=ndjson]")).toHaveAttribute(
      "href",
      "/acme/audit/export?outcome=deny&capability=purchase_gau_bucket&format=ndjson",
    );
  });

  it("reads the day filters as days on the viewer's clock, inclusive of the last", async () => {
    events.mockResolvedValue(recordOf([event()]));
    await renderAudit({ from: "2026-01-15", to: "2026-01-15" });

    // PST (UTC-8): local midnight is 08:00 UTC, and the day is inclusive, so
    // the exclusive bound is the next local midnight.
    expect(events.mock.calls[0]?.[1]).toMatchObject({
      since: "2026-01-15T08:00:00.000Z",
      until: "2026-01-16T08:00:00.000Z",
    });
    expect(preferences).toHaveBeenCalledOnce();
    // The links keep the days the reader typed, not the instants.
    expect(at("[data-export=csv]")).toHaveAttribute(
      "href",
      "/acme/audit/export?from=2026-01-15&to=2026-01-15&format=csv",
    );
  });

  it("falls back to the default zone when the preference cannot be read (negative)", async () => {
    preferences.mockResolvedValue(readError("control_plane_unavailable", 503));
    events.mockResolvedValue(recordOf([event()]));
    await renderAudit({ from: "2026-01-15" });
    // Pacific is the default every page prints in, so the bound matches it.
    expect(events.mock.calls[0]?.[1]).toMatchObject({
      since: "2026-01-15T08:00:00.000Z",
      until: null,
    });
  });

  it("drops a filter value the record cannot hold rather than asking the contract for it (negative)", async () => {
    events.mockResolvedValue(recordOf([event()]));
    await renderAudit({ outcome: "maybe", offset: "-40" });
    expect(events.mock.calls[0]?.[1]).toMatchObject({
      outcome: null,
      offset: 0,
    });
  });

  it("offers the older page while one exists, and no newer page on the first", async () => {
    events.mockResolvedValue(recordOf([event()], { hasMore: true }));
    await renderAudit();
    expect(at("[data-page=older]")).toHaveAttribute(
      "href",
      "/acme/audit?offset=50",
    );
    expect(at("[data-page=newer]")).toBeNull();
    expect(screen.queryByText("End of the record")).toBeNull();
  });

  it("says the record ends here on the last page, and offers the newer one", async () => {
    events.mockResolvedValue(
      recordOf([event()], { hasMore: false, offset: 50 }),
    );
    await renderAudit({ offset: "50" });
    expect(screen.getByText("End of the record")).toBeInTheDocument();
    expect(at("[data-page=older]")).toBeNull();
    expect(at("[data-page=newer]")).toHaveAttribute("href", "/acme/audit");
  });
});

describe("an answer with no events", () => {
  it("says the record is empty when nothing is filtered", async () => {
    events.mockResolvedValue(recordOf([]));
    await renderAudit();
    expect(at("[data-state=empty]")).toHaveTextContent("No audit events yet");
    expect(at("[data-state=empty]")).toHaveTextContent("written by the kernel");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("tells an empty answer from an empty record when a filter is set", async () => {
    events.mockResolvedValue(recordOf([]));
    await renderAudit({ outcome: "deny" });
    const filtered = at("[data-state=filtered-empty]");
    expect(filtered).toHaveTextContent("No events match these filters");
    expect(at("[data-state=empty]")).toBeNull();
    expect(filtered?.querySelector("a")).toHaveAttribute("href", "/acme/audit");
  });
});

describe("a read the page could not make", () => {
  it("renders the refusal with the role it needs, and offers no export (negative)", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    await renderAudit({}, memberCtx);
    const denied = screen.getByTestId("audit-denied");
    expect(denied).toHaveTextContent("You cannot see the audit record");
    expect(denied).toHaveTextContent("Signed in as a member");
    expect(denied).toHaveTextContent("org.admin");
    expect(screen.queryByRole("table")).toBeNull();
    expect(at("[data-export=csv]")).toBeNull();
    expect(at("[data-state=empty]")).toBeNull();
  });

  it("renders a pending access request rather than an empty record (negative)", async () => {
    events.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_7Qx",
    });
    await renderAudit();
    expect(screen.getByTestId("audit-pending")).toHaveTextContent("acr_7Qx");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No audit events yet")).toBeNull();
  });

  it("names the failure and never reads it as an empty record (negative)", async () => {
    events.mockResolvedValue(readError("audit_store_unavailable", 503));
    await renderAudit();
    const failed = screen.getByTestId("audit-error");
    expect(failed).toHaveTextContent("503 audit_store_unavailable");
    expect(failed).toHaveTextContent("Runs kept recording");
    expect(within(failed).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/audit",
    );
    expect(screen.queryByText("No audit events yet")).toBeNull();
  });

  it("still reads the record when the roster cannot be read, printing the actor's id", async () => {
    events.mockResolvedValue(recordOf([event()]));
    members.mockResolvedValue(readError("control_plane_unavailable", 503));
    await renderAudit();
    expect(screen.getByLabelText("Actor")).toBeInTheDocument();
    expect(rowOf("capability.invoke_denied")).toHaveTextContent(ADA);
  });
});

describe("the skeleton", () => {
  it("announces that the record is being read, and shows no record", () => {
    render(
      <IntlProvider>
        <AuditSkeleton />
      </IntlProvider>,
    );
    const loading = screen.getByLabelText("Loading the audit record");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveAttribute("data-state", "loading");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
