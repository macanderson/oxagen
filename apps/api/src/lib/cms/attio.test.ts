/**
 * Unit tests for the Attio client (attio.ts): request shape per endpoint,
 * record id extraction, and the retry policy. `fetch` is injected, so no
 * network is touched.
 */

import { describe, it, expect, vi } from "vitest";
import { ATTIO_BASE_URL, AttioRequestError, createAttioClient } from "./attio";

function jsonResponse(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

const PERSON_OK = { data: { id: { record_id: "person-1" } } };
const COMPANY_OK = { data: { id: { record_id: "company-1" } } };
const NOTE_OK = { data: { id: { note_id: "note-1" } } };
const ENTRY_OK = { data: { id: { entry_id: "entry-1" } } };

function makeClient(fetchImpl: typeof fetch, extra = {}) {
  return createAttioClient({
    apiKey: "secret",
    fetch: fetchImpl,
    sleep: async () => {},
    ...extra,
  });
}

describe("createAttioClient", () => {
  it("asserts a person by email with name, title, phone and company link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, PERSON_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const out = await client.assertPerson({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: "CTO",
      phone: "+15558675309",
      companyRecordId: "company-1",
    });

    expect(out).toEqual({ recordId: "person-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${ATTIO_BASE_URL}/objects/people/records?matching_attribute=email_addresses`,
    );
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toEqual({
      data: {
        values: {
          email_addresses: [{ email_address: "ada@example.com" }],
          name: [
            {
              first_name: "Ada",
              last_name: "Lovelace",
              full_name: "Ada Lovelace",
            },
          ],
          job_title: [{ value: "CTO" }],
          phone_numbers: [{ original_phone_number: "+15558675309" }],
          company: [
            { target_object: "companies", target_record_id: "company-1" },
          ],
        },
      },
    });
  });

  it("omits optional person attributes that are empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, PERSON_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await client.assertPerson({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: null,
      phone: null,
      companyRecordId: null,
    });
    const values = JSON.parse(fetchMock.mock.calls[0]![1].body).data.values;
    expect(Object.keys(values).sort()).toEqual(["email_addresses", "name"]);
  });

  it("asserts a company by domain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, COMPANY_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.assertCompany({
      domain: "example.com",
      name: "Example",
    });
    expect(out).toEqual({ recordId: "company-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${ATTIO_BASE_URL}/objects/companies/records?matching_attribute=domains`,
    );
    expect(JSON.parse(init.body)).toEqual({
      data: {
        values: {
          domains: [{ domain: "example.com" }],
          name: [{ value: "Example" }],
        },
      },
    });
  });

  it("creates a plaintext note on the parent record", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, NOTE_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.createNote({
      parentObject: "people",
      parentRecordId: "person-1",
      title: "Website lead: demo",
      content: "Source: demo",
    });
    expect(out).toEqual({ noteId: "note-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ATTIO_BASE_URL}/notes`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      data: {
        parent_object: "people",
        parent_record_id: "person-1",
        title: "Website lead: demo",
        format: "plaintext",
        content: "Source: demo",
      },
    });
  });

  it("asserts a list entry by parent with no values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, ENTRY_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.assertListEntry({
      list: "inbound_lead_nurture",
      parentObject: "people",
      parentRecordId: "person-1",
    });
    expect(out).toEqual({ entryId: "entry-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ATTIO_BASE_URL}/lists/inbound_lead_nurture/entries`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      data: {
        parent_record_id: "person-1",
        parent_object: "people",
        entry_values: {},
      },
    });
  });

  it("appends list entry values with PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, ENTRY_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await client.appendListEntryValues({
      list: "inbound_lead_nurture",
      entryId: "entry-1",
      values: { asset: ["Field manual"] },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${ATTIO_BASE_URL}/lists/inbound_lead_nurture/entries/entry-1`,
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      data: { entry_values: { asset: ["Field manual"] } },
    });
  });

  it("rejects a list entry assert that carries no entry id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: {} }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(
      client.assertListEntry({
        list: "l",
        parentObject: "people",
        parentRecordId: "p",
      }),
    ).rejects.toThrow("no entry_id");
  });

  it("retries 429 and 5xx, honouring Retry-After, then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { error: "slow down" }, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
      .mockResolvedValueOnce(jsonResponse(200, COMPANY_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch, { sleep });
    const out = await client.assertCompany({ domain: "x.io", name: "X" });
    expect(out.recordId).toBe("company-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });

  it("gives up after maxAttempts with the last error", async () => {
    // A fresh Response per attempt: a body can be read once.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(500, { error: "still down" }),
      );
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      maxAttempts: 2,
    });
    await expect(
      client.assertCompany({ domain: "x.io", name: "X" }),
    ).rejects.toMatchObject({
      name: "AttioRequestError",
      status: 500,
      code: "attio_request_failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx other than 429", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(400, { error: "bad phone" }),
      );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(
      client.assertPerson({
        email: "a@b.co",
        firstName: "A",
        lastName: "B",
      }),
    ).rejects.toBeInstanceOf(AttioRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure on an assert and rethrows when attempts run out", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      maxAttempts: 2,
    });
    await expect(
      client.assertCompany({ domain: "x.io", name: "X" }),
    ).rejects.toThrow("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a note whose response was lost (it may already exist)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(
      client.createNote({
        parentObject: "people",
        parentRecordId: "p",
        title: "t",
        content: "c",
      }),
    ).rejects.toThrow("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a note Attio refused with a 5xx (nothing was created)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
      .mockResolvedValueOnce(jsonResponse(200, NOTE_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.createNote({
      parentObject: "people",
      parentRecordId: "p",
      title: "t",
      content: "c",
    });
    expect(out).toEqual({ noteId: "note-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds every attempt with an abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, COMPANY_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      timeoutMs: 1234,
    });
    await client.assertCompany({ domain: "x.io", name: "X" });
    const init = fetchMock.mock.calls[0]![1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it("removes a record's entry from a list when it has one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            { list_id: "other-list", entry_id: "e-other" },
            { list_id: "list-1", entry_id: "e-1" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.removeListEntry({
      listId: "list-1",
      listSlug: "nurture",
      parentObject: "people",
      parentRecordId: "person-1",
    });
    expect(out).toEqual({ removed: true });
    const [url1, init1] = fetchMock.mock.calls[0]!;
    expect(url1).toBe(
      `${ATTIO_BASE_URL}/objects/people/records/person-1/entries?limit=50`,
    );
    expect(init1.method).toBe("GET");
    expect(init1.body).toBeUndefined();
    const [url2, init2] = fetchMock.mock.calls[1]!;
    expect(url2).toBe(`${ATTIO_BASE_URL}/lists/nurture/entries/e-1`);
    expect(init2.method).toBe("DELETE");
  });

  it("reports removed:false when the record is not on the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.removeListEntry({
      listId: "list-1",
      listSlug: "nurture",
      parentObject: "people",
      parentRecordId: "person-1",
    });
    expect(out).toEqual({ removed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a 200 that carries no record id or note id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(
      client.assertCompany({ domain: "x.io", name: "X" }),
    ).rejects.toThrow("no record_id");
    await expect(
      client.createNote({
        parentObject: "people",
        parentRecordId: "p",
        title: "t",
        content: "c",
      }),
    ).rejects.toThrow("no note_id");
  });
});
