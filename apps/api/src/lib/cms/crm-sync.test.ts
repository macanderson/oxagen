/**
 * Unit tests for the lead → Attio sync (crm-sync.ts).
 *
 * withSystemDb is mocked with a scripted fake transaction (selects resolve to
 * queued rows; update().set() payloads are recorded), and the Attio client is
 * an in-memory fake, so the tests cover the mapping, the write-back and the
 * failure paths without a database or the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  sets: [] as Record<string, unknown>[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  const chain = (resolveVal: () => unknown, onSet?: (v: unknown) => void) => {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(resolveVal());
        }
        return (arg?: unknown) => {
          if (prop === "set" && onSet) onSet(arg);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const tx = {
    select: () =>
      chain(() => {
        const next = h.selects.shift();
        if (next instanceof Error) throw next;
        return next ?? [];
      }),
    update: () =>
      chain(
        () => undefined,
        (v) => h.sets.push(v as Record<string, unknown>),
      ),
  };
  return {
    ...actual,
    withSystemDb: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> =>
      fn(tx),
  };
});

vi.mock("../../middleware/logger", () => ({ logger: h.logger }));

import type { AttioClient } from "./attio";
import {
  CONSUMER_EMAIL_DOMAINS,
  __resetCrmClientForTests,
  buildLeadNote,
  companyNameFor,
  e164OrNull,
  emailDomain,
  isCrmSyncConfigured,
  queueCrmSync,
  syncLeadToCrm,
  syncPendingLeads,
  type LeadRecord,
} from "./crm-sync";

function lead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: "lead-1",
    publicId: "lead_abc",
    createdAt: new Date("2026-09-19T10:00:00Z"),
    updatedAt: new Date("2026-09-19T10:05:00Z"),
    createdById: null,
    updatedById: null,
    email: "ada@compilers.inc",
    firstName: "Ada",
    lastName: "Lovelace",
    jobTitle: "CTO",
    company: "Compilers Inc",
    companySize: "51-200",
    mobilePhone: "+1 (555) 867-5309",
    country: "UK",
    state: null,
    city: "London",
    address1: null,
    address2: null,
    referralSource: "word_of_mouth",
    trackingCode: "utm_source=hn",
    source: "demo",
    pagePath: "/#demo",
    message: "Forty agents on a Rails monolith.",
    marketingConsent: true,
    crmRecordId: null,
    crmSyncedAt: null,
    crmSyncError: null,
    ...overrides,
  } as LeadRecord;
}

function fakeClient(overrides: Partial<AttioClient> = {}) {
  const client: AttioClient = {
    assertCompany: vi.fn().mockResolvedValue({ recordId: "company-1" }),
    assertPerson: vi.fn().mockResolvedValue({ recordId: "person-1" }),
    createNote: vi.fn().mockResolvedValue({ noteId: "note-1" }),
    ...overrides,
  };
  return client;
}

beforeEach(() => {
  h.selects.length = 0;
  h.sets.length = 0;
  vi.clearAllMocks();
  __resetCrmClientForTests();
  delete process.env.ATTIO_API_KEY;
});

afterEach(() => {
  delete process.env.ATTIO_API_KEY;
});

describe("helpers", () => {
  it("emailDomain lowercases and handles malformed input", () => {
    expect(emailDomain("Ada@Compilers.INC")).toBe("compilers.inc");
    expect(emailDomain("nope")).toBeNull();
    expect(emailDomain("trailing@")).toBeNull();
  });

  it("e164OrNull keeps only unambiguous international numbers", () => {
    expect(e164OrNull("+1 (555) 867-5309")).toBe("+15558675309");
    expect(e164OrNull("555-867-5309")).toBeNull();
    expect(e164OrNull("+0123")).toBeNull();
    expect(e164OrNull(null)).toBeNull();
  });

  it("companyNameFor prefers the form's company, else the domain", () => {
    expect(companyNameFor(lead(), "compilers.inc")).toBe("Compilers Inc");
    expect(companyNameFor(lead({ company: "  " }), "compilers.inc")).toBe(
      "compilers.inc",
    );
  });

  it("buildLeadNote carries the fields Attio has no attribute for", () => {
    const note = buildLeadNote(lead());
    expect(note.title).toBe("Website lead: demo");
    expect(note.content).toContain("Source: demo");
    expect(note.content).toContain("Page: /#demo");
    expect(note.content).toContain("Company size: 51-200");
    expect(note.content).toContain("Location: London, UK");
    expect(note.content).toContain("Heard about us via: word of mouth");
    expect(note.content).toContain("Tracking code: utm_source=hn");
    expect(note.content).toContain("Marketing consent: yes");
    expect(note.content).toContain("Submitted: 2026-09-19T10:05:00.000Z");
    expect(note.content).toContain(
      "What they are building:\nForty agents on a Rails monolith.",
    );
  });

  it("buildLeadNote skips empty fields and defaults the source", () => {
    const note = buildLeadNote(
      lead({
        source: null,
        pagePath: null,
        company: null,
        companySize: null,
        jobTitle: null,
        mobilePhone: null,
        country: null,
        city: null,
        referralSource: null,
        trackingCode: null,
        message: "   ",
        marketingConsent: false,
      }),
    );
    expect(note.title).toBe("Website lead: website");
    expect(note.content).not.toContain("Page:");
    expect(note.content).not.toContain("Location:");
    expect(note.content).not.toContain("What they are building");
    expect(note.content).toContain("Marketing consent: no");
  });

  it("isCrmSyncConfigured follows ATTIO_API_KEY", () => {
    expect(isCrmSyncConfigured()).toBe(false);
    process.env.ATTIO_API_KEY = "k";
    expect(isCrmSyncConfigured()).toBe(true);
  });

  it("CONSUMER_EMAIL_DOMAINS names the common mailboxes", () => {
    expect(CONSUMER_EMAIL_DOMAINS.has("gmail.com")).toBe(true);
    expect(CONSUMER_EMAIL_DOMAINS.has("compilers.inc")).toBe(false);
  });
});

describe("syncLeadToCrm", () => {
  it("asserts company then person, writes a note, records the record id", async () => {
    h.selects.push([lead()]);
    const client = fakeClient();

    const out = await syncLeadToCrm("lead-1", client);

    expect(out).toEqual({
      status: "synced",
      leadId: "lead-1",
      recordId: "person-1",
    });
    expect(client.assertCompany).toHaveBeenCalledWith({
      domain: "compilers.inc",
      name: "Compilers Inc",
    });
    expect(client.assertPerson).toHaveBeenCalledWith({
      email: "ada@compilers.inc",
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: "CTO",
      phone: "+15558675309",
      companyRecordId: "company-1",
    });
    expect(client.createNote).toHaveBeenCalledWith(
      expect.objectContaining({
        parentObject: "people",
        parentRecordId: "person-1",
        title: "Website lead: demo",
      }),
    );
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]).toMatchObject({
      crmRecordId: "person-1",
      crmSyncError: null,
    });
    expect(h.sets[0]!.crmSyncedAt).toBeInstanceOf(Date);
  });

  it("skips the company for a consumer mailbox", async () => {
    h.selects.push([lead({ email: "ada@gmail.com", company: null })]);
    const client = fakeClient();
    await syncLeadToCrm("lead-1", client);
    expect(client.assertCompany).not.toHaveBeenCalled();
    expect(client.assertPerson).toHaveBeenCalledWith(
      expect.objectContaining({ companyRecordId: null }),
    );
  });

  it("returns not_configured without touching the database when no client", async () => {
    const out = await syncLeadToCrm("lead-1", null);
    expect(out).toEqual({
      status: "skipped",
      leadId: "lead-1",
      reason: "not_configured",
    });
    expect(h.sets).toHaveLength(0);
  });

  it("builds a client from ATTIO_API_KEY when none is passed", async () => {
    process.env.ATTIO_API_KEY = "k";
    // The default client is real; make its fetch fail fast so the test
    // proves the env was read without reaching the network.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    h.selects.push([lead({ email: "ada@gmail.com" })]);
    const out = await syncLeadToCrm("lead-1");
    expect(out.status).toBe("failed");
    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      headers: expect.objectContaining({ authorization: "Bearer k" }),
    });
    fetchSpy.mockRestore();
  });

  it("returns not_found for an unknown lead", async () => {
    h.selects.push([]);
    const out = await syncLeadToCrm("lead-9", fakeClient());
    expect(out).toEqual({
      status: "skipped",
      leadId: "lead-9",
      reason: "not_found",
    });
  });

  it("records the failure on the row and never throws", async () => {
    h.selects.push([lead()]);
    const client = fakeClient({
      assertPerson: vi.fn().mockRejectedValue(new Error("Attio said 400")),
    });
    const out = await syncLeadToCrm("lead-1", client);
    expect(out).toEqual({
      status: "failed",
      leadId: "lead-1",
      error: "Attio said 400",
    });
    expect(client.createNote).not.toHaveBeenCalled();
    expect(h.sets[0]).toEqual({ crmSyncError: "Attio said 400" });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("truncates a long failure message to 500 chars", async () => {
    h.selects.push([lead()]);
    const client = fakeClient({
      assertCompany: vi.fn().mockRejectedValue(new Error("x".repeat(900))),
    });
    await syncLeadToCrm("lead-1", client);
    expect((h.sets[0]!.crmSyncError as string).length).toBe(500);
  });

  it("reports a failure when the lead cannot be loaded", async () => {
    h.selects.push(new Error("connection refused") as unknown as unknown[]);
    const out = await syncLeadToCrm("lead-1", fakeClient());
    expect(out).toEqual({
      status: "failed",
      leadId: "lead-1",
      error: "connection refused",
    });
    expect(h.sets).toHaveLength(0);
  });
});

describe("queueCrmSync", () => {
  it("does nothing when unconfigured", async () => {
    queueCrmSync("lead-1");
    await new Promise((r) => setImmediate(r));
    expect(h.sets).toHaveLength(0);
  });

  it("runs the sync in the background when configured", async () => {
    process.env.ATTIO_API_KEY = "k";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    h.selects.push([lead({ email: "ada@gmail.com" })]);
    queueCrmSync("lead-1");
    await vi.waitFor(() => expect(h.sets).toHaveLength(1));
    expect(h.sets[0]).toMatchObject({ crmSyncError: "offline" });
    fetchSpy.mockRestore();
  });
});

describe("syncPendingLeads", () => {
  it("syncs each pending lead oldest first and returns the outcomes", async () => {
    h.selects.push([{ id: "lead-1" }, { id: "lead-2" }]);
    h.selects.push([lead({ id: "lead-1" })]);
    h.selects.push([lead({ id: "lead-2", email: "b@gmail.com" })]);
    const client = fakeClient();
    const out = await syncPendingLeads({ client, limit: 10 });
    expect(out.map((r) => r.status)).toEqual(["synced", "synced"]);
    expect(client.assertPerson).toHaveBeenCalledTimes(2);
    expect(h.sets).toHaveLength(2);
  });

  it("uses the default limit and client when none are given", async () => {
    h.selects.push([]);
    const out = await syncPendingLeads();
    expect(out).toEqual([]);
  });
});
