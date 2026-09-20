/**
 * Unit tests for the lead → Attio sync (crm-sync.ts).
 *
 * withSystemDb is mocked with a scripted fake transaction (selects resolve to
 * queued rows in order: the lead row, then its access codes' editions;
 * update().set() payloads are recorded), and the Attio client is
 * an in-memory fake, so the tests cover the mapping, the write-back and the
 * failure paths without a database or the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  sets: [] as Record<string, unknown>[],
  locks: [] as string[],
  currentRevision: null as string | null,
  applied: [] as Record<string, unknown>[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
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
  const nextSelect = () => {
    const next = h.selects.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  };
  const tx = {
    execute: async (query: import("drizzle-orm").SQL) => {
      const compiled = dialect.sqlToQuery(query);
      expect(compiled.sql).toContain("pg_advisory_xact_lock");
      h.locks.push(String(compiled.params[0]));
    },
    select: () => chain(nextSelect),
    selectDistinct: () => chain(nextSelect),
    update: () => {
      let values: Record<string, unknown>;
      let condition: import("drizzle-orm").SQL;
      return {
        set(v: Record<string, unknown>) {
          values = v;
          h.sets.push(v);
          return this;
        },
        where(v: import("drizzle-orm").SQL) {
          condition = v;
          return this;
        },
        async returning() {
          const query = dialect.sqlToQuery(condition);
          const matches =
            h.currentRevision === null ||
            query.params.includes(h.currentRevision);
          if (!matches) return [];
          h.applied.push(values);
          return [{ id: "lead-1" }];
        },
      };
    },
  };
  const locks = new Map<string, Promise<void>>();
  return {
    ...actual,
    withSystemDb: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      let release: (() => void) | undefined;
      try {
        return await fn({
          ...tx,
          execute: async (query: import("drizzle-orm").SQL) => {
            const key = String(dialect.sqlToQuery(query).params[0]);
            const previous = locks.get(key);
            locks.set(
              key,
              new Promise<void>((resolve) => {
                release = resolve;
              }),
            );
            await previous;
            await tx.execute(query);
          },
        });
      } finally {
        release?.();
      }
    },
  };
});

vi.mock("../../middleware/logger", () => ({ logger: h.logger }));

import type { AttioClient } from "./attio";
import {
  ASSET_TITLES,
  CONSUMER_EMAIL_DOMAINS,
  NURTURE_LIST_ID,
  NURTURE_LIST_SLUG,
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

function lead(
  overrides: Partial<LeadRecord> = {},
): LeadRecord & { revision: string } {
  return {
    revision: "2026-09-19 10:05:00.123456+00",
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
    address1: "1 Analytical Engine Way",
    address2: "Floor 2",
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
  } as LeadRecord & { revision: string };
}

function fakeClient(overrides: Partial<AttioClient> = {}) {
  const client: AttioClient = {
    assertCompany: vi.fn().mockResolvedValue({ recordId: "company-1" }),
    assertPerson: vi.fn().mockResolvedValue({ recordId: "person-1" }),
    createNote: vi.fn().mockResolvedValue({ noteId: "note-1" }),
    assertListEntry: vi.fn().mockResolvedValue({ entryId: "entry-1" }),
    appendListEntryValues: vi.fn().mockResolvedValue(undefined),
    removeListEntry: vi.fn().mockResolvedValue({ removed: true }),
    ...overrides,
  };
  return client;
}

beforeEach(() => {
  h.selects.length = 0;
  h.sets.length = 0;
  h.currentRevision = null;
  h.applied.length = 0;
  h.locks.length = 0;
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
    expect(note.content).toContain("Address: 1 Analytical Engine Way, Floor 2");
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
        address1: null,
        address2: null,
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
    expect(note.content).not.toContain("Address:");
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
    h.selects.push([
      { edition: "field-manual" },
      { edition: "page-flip-reader" },
    ]);
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
    expect(client.assertListEntry).toHaveBeenCalledWith({
      list: NURTURE_LIST_SLUG,
      parentObject: "people",
      parentRecordId: "person-1",
    });
    expect(client.appendListEntryValues).toHaveBeenCalledWith({
      list: NURTURE_LIST_SLUG,
      entryId: "entry-1",
      values: { asset: ["Field manual", "Page-flip reader"] },
    });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]).toMatchObject({
      crmRecordId: "person-1",
      crmSyncError: null,
    });
    expect(h.sets[0]!.crmSyncedAt).toBeInstanceOf(Date);
  });

  it("keeps an opted-out book lead off the nurture list and removes an existing entry", async () => {
    h.selects.push([lead({ marketingConsent: false })]);
    h.selects.push([{ edition: "field-manual" }]);
    const client = fakeClient();
    const out = await syncLeadToCrm("lead-1", client);
    expect(out.status).toBe("synced");
    expect(client.assertListEntry).not.toHaveBeenCalled();
    expect(client.appendListEntryValues).not.toHaveBeenCalled();
    expect(client.removeListEntry).toHaveBeenCalledWith({
      listId: NURTURE_LIST_ID,
      listSlug: NURTURE_LIST_SLUG,
      parentObject: "people",
      parentRecordId: "person-1",
    });
    // The person and the note still land: consent governs the nurture
    // list, not whether sales can see who asked.
    expect(client.assertPerson).toHaveBeenCalled();
    expect(client.createNote).toHaveBeenCalled();
  });

  it("keeps a demo-only lead (no access codes) off the nurture list", async () => {
    h.selects.push([lead()]);
    h.selects.push([]);
    const client = fakeClient();
    const out = await syncLeadToCrm("lead-1", client);
    expect(out.status).toBe("synced");
    expect(client.assertListEntry).not.toHaveBeenCalled();
    expect(client.appendListEntryValues).not.toHaveBeenCalled();
    expect(client.removeListEntry).not.toHaveBeenCalled();
  });

  it("ignores a code whose edition is unknown or null", async () => {
    h.selects.push([lead()]);
    h.selects.push([{ edition: null }, { edition: "mystery" }]);
    const client = fakeClient();
    await syncLeadToCrm("lead-1", client);
    expect(client.assertListEntry).not.toHaveBeenCalled();
  });

  it("ASSET_TITLES names every edition", () => {
    expect(ASSET_TITLES).toEqual({
      "field-manual": "Field manual",
      "page-flip-reader": "Page-flip reader",
    });
  });

  it("skips the company for a consumer mailbox", async () => {
    h.selects.push([lead({ email: "ada@gmail.com", company: null })]);
    h.selects.push([]);
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
    h.selects.push([]);
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
    h.selects.push([]);
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
    h.selects.push([]);
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
    h.selects.push([]);
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
    h.selects.push([{ edition: "field-manual" }]);
    h.selects.push([lead({ id: "lead-2", email: "b@gmail.com" })]);
    h.selects.push([]);
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

describe("resubmission during CRM sync", () => {
  it("leaves a newer submission pending for the backfill", async () => {
    const snapshot = lead();
    h.currentRevision = snapshot.revision;
    h.selects.push([snapshot], []);
    const out = await syncLeadToCrm(
      snapshot.id,
      fakeClient({
        createNote: vi.fn().mockImplementation(async () => {
          h.currentRevision = "2026-09-19 10:05:00.123457+00";
          return { noteId: "note-1" };
        }),
      }),
    );
    expect(out).toEqual({
      status: "skipped",
      leadId: snapshot.id,
      reason: "resubmitted",
    });
    expect(h.applied).toEqual([]);

    const latest = { ...snapshot, revision: h.currentRevision };
    h.selects.push([{ id: snapshot.id }], [latest], []);
    expect(await syncPendingLeads({ client: fakeClient() })).toEqual([
      { status: "synced", leadId: snapshot.id, recordId: "person-1" },
    ]);
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toMatchObject({
      crmRecordId: "person-1",
      crmSyncError: null,
    });
  });

  it("does not overwrite a newer submission's error with an older failure", async () => {
    const snapshot = lead();
    h.selects.push([snapshot], []);
    await syncLeadToCrm(
      snapshot.id,
      fakeClient({
        assertPerson: vi.fn().mockImplementation(async () => {
          h.currentRevision = "2026-09-19 10:06:00.000001+00";
          throw new Error("older sync failed");
        }),
      }),
    );
    expect(h.applied).toEqual([]);
  });

  it("matches the full database timestamp without losing microseconds", async () => {
    const snapshot = lead();
    h.currentRevision = snapshot.revision;
    h.selects.push([snapshot], []);
    expect(await syncLeadToCrm(snapshot.id, fakeClient())).toMatchObject({
      status: "synced",
    });
    expect(h.applied).toHaveLength(1);
    expect(h.locks).toEqual(["cms-crm:lead-1"]);
  });
});

describe("concurrent CRM writers", () => {
  it("finishes the old sync before loading and syncing a resubmission", async () => {
    const first = lead();
    const second = {
      ...first,
      firstName: "New name",
      revision: "2026-09-19 10:06:00.000001+00",
    };
    h.selects.push([first], [], [second], []);
    h.currentRevision = first.revision;
    let releaseFirst!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: string[] = [];
    const oldClient = fakeClient({
      assertPerson: vi.fn().mockImplementation(async () => {
        signalStarted();
        await blocked;
        writes.push("old");
        return { recordId: "person-1" };
      }),
    });
    const newClient = fakeClient({
      assertPerson: vi.fn().mockImplementation(async () => {
        writes.push("new");
        return { recordId: "person-1" };
      }),
    });
    const oldSync = syncLeadToCrm(first.id, oldClient);
    await started;
    h.currentRevision = second.revision;
    const newSync = syncLeadToCrm(first.id, newClient);
    await Promise.resolve();
    expect(newClient.assertPerson).not.toHaveBeenCalled();
    releaseFirst();
    expect(await oldSync).toMatchObject({
      status: "skipped",
      reason: "resubmitted",
    });
    expect(await newSync).toMatchObject({ status: "synced" });
    expect(writes).toEqual(["old", "new"]);
    expect(newClient.assertPerson).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "New name" }),
    );
    expect(h.applied).toHaveLength(1);
  });
});
