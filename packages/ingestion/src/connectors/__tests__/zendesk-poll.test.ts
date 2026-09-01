import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zendesk } from "../zendesk/index";
import type { AuthCredential, RawRecord } from "../types";

const apiToken: AuthCredential = { scheme: "api_key", apiKey: "tok123" };
const config = {
  subdomain: "acme",
  email: "agent@acme.com",
  syncDepthDays: 90,
  pageSize: 1000,
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function collect(iter: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

function urlOfCall(index: number): string {
  return (fetchMock.mock.calls[index] as [string])[0];
}

function paramOf(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

function headersOfCall(index: number): Record<string, string> {
  const [, opts] = fetchMock.mock.calls[index] as [string, RequestInit];
  return opts.headers as Record<string, string>;
}

/** The Authorization value Zendesk expects for a given basic pair. */
function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/** A terminal one-page response for the given collection. */
function lastPage(key: string, items: unknown[]) {
  return jsonResponse({
    [key]: items,
    end_of_stream: true,
    end_time: 1_700_000_000,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("zendesk.poll — credential handling", () => {
  it("yields nothing for a credential scheme Zendesk cannot use", async () => {
    expect(
      await collect(
        zendesk.poll!({ scheme: "public" }, config, "ticket", null),
      ),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("yields nothing for an API token with no agent email to pair it with", async () => {
    const noEmail = { ...config, email: undefined };
    expect(
      await collect(zendesk.poll!(apiToken, noEmail, "ticket", null)),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an API token as basic auth against the agent email with the /token suffix", async () => {
    fetchMock.mockResolvedValue(lastPage("tickets", []));
    await collect(zendesk.poll!(apiToken, config, "ticket", null));
    expect(headersOfCall(0).Authorization).toBe(
      basic("agent@acme.com/token", "tok123"),
    );
  });

  it("sends an OAuth token as a bearer, with no email needed", async () => {
    fetchMock.mockResolvedValue(lastPage("tickets", []));
    const oauth: AuthCredential = {
      scheme: "bearer_token",
      token: "oauth-tok",
    };
    await collect(
      zendesk.poll!(oauth, { ...config, email: undefined }, "ticket", null),
    );
    expect(headersOfCall(0).Authorization).toBe("Bearer oauth-tok");
  });

  it("sends a stored basic credential verbatim", async () => {
    fetchMock.mockResolvedValue(lastPage("tickets", []));
    const stored: AuthCredential = {
      scheme: "basic_auth",
      username: "agent@acme.com/token",
      password: "tok123",
    };
    await collect(
      zendesk.poll!(stored, { ...config, email: undefined }, "ticket", null),
    );
    expect(headersOfCall(0).Authorization).toBe(
      basic("agent@acme.com/token", "tok123"),
    );
  });
});

describe("zendesk.poll — request shape", () => {
  it("yields nothing for a record type with no incremental export", async () => {
    expect(
      await collect(zendesk.poll!(apiToken, config, "macro", null)),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls each record type at its own incremental export endpoint", async () => {
    const expected: Record<string, string> = {
      ticket: "/api/v2/incremental/tickets.json",
      user: "/api/v2/incremental/users.json",
      organization: "/api/v2/incremental/organizations.json",
      ticket_comment: "/api/v2/incremental/ticket_events.json",
    };
    for (const [recordType, path] of Object.entries(expected)) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(jsonResponse({ end_of_stream: true }));
      await collect(zendesk.poll!(apiToken, config, recordType, null));
      const url = new URL(urlOfCall(0));
      expect(url.origin).toBe("https://acme.zendesk.com");
      expect(url.pathname).toBe(path);
      expect(paramOf(urlOfCall(0), "per_page")).toBe("1000");
    }
  });

  it("asks for comment_events only when polling comments", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ end_of_stream: true }));
    await collect(zendesk.poll!(apiToken, config, "ticket_comment", null));
    expect(paramOf(urlOfCall(0), "include")).toBe("comment_events");

    fetchMock.mockClear();
    await collect(zendesk.poll!(apiToken, config, "ticket", null));
    expect(paramOf(urlOfCall(0), "include")).toBeNull();
  });

  it("bounds the first poll by syncDepthDays", async () => {
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    fetchMock.mockResolvedValue(lastPage("tickets", []));
    await collect(
      zendesk.poll!(apiToken, { ...config, syncDepthDays: 30 }, "ticket", null),
    );
    const nowSec = Math.floor(Date.parse("2026-03-01T00:00:00.000Z") / 1000);
    expect(Number(paramOf(urlOfCall(0), "start_time"))).toBe(
      nowSec - 30 * 86_400,
    );
  });

  it("seeds start_time from the durable cursor on an incremental poll", async () => {
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    fetchMock.mockResolvedValue(lastPage("tickets", []));
    await collect(
      zendesk.poll!(apiToken, config, "ticket", "2026-02-01T00:00:00.000Z"),
    );
    expect(paramOf(urlOfCall(0), "start_time")).toBe(
      String(Math.floor(Date.parse("2026-02-01T00:00:00.000Z") / 1000)),
    );
  });

  it("holds start_time a minute back, which Zendesk requires", async () => {
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    fetchMock.mockResolvedValue(lastPage("tickets", []));
    // A cursor at "now" would otherwise ask for a window Zendesk rejects.
    await collect(
      zendesk.poll!(apiToken, config, "ticket", "2026-03-01T00:00:00.000Z"),
    );
    const nowSec = Math.floor(Date.parse("2026-03-01T00:00:00.000Z") / 1000);
    expect(Number(paramOf(urlOfCall(0), "start_time"))).toBe(nowSec - 60);
  });

  it("falls back to the sync window when the cursor is unparseable", async () => {
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    fetchMock.mockResolvedValue(lastPage("tickets", []));
    await collect(
      zendesk.poll!(
        apiToken,
        { ...config, syncDepthDays: 30 },
        "ticket",
        "garbage",
      ),
    );
    const nowSec = Math.floor(Date.parse("2026-03-01T00:00:00.000Z") / 1000);
    expect(Number(paramOf(urlOfCall(0), "start_time"))).toBe(
      nowSec - 30 * 86_400,
    );
  });
});

describe("zendesk.poll — pagination", () => {
  it("follows next_page across a page boundary until end_of_stream", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          tickets: [
            { id: 1, updated_at: "2026-03-01T00:00:00Z" },
            { id: 2, updated_at: "2026-03-02T00:00:00Z" },
          ],
          end_of_stream: false,
          next_page:
            "https://acme.zendesk.com/api/v2/incremental/tickets.json?start_time=1772409600",
        }),
      )
      .mockResolvedValueOnce(
        lastPage("tickets", [{ id: 3, updated_at: "2026-03-03T00:00:00Z" }]),
      );

    const out = await collect(zendesk.poll!(apiToken, config, "ticket", null));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.map((r) => r.externalId)).toEqual(["1", "2", "3"]);
    // The second request is Zendesk's own next_page, carrying the next window.
    expect(paramOf(urlOfCall(1), "start_time")).toBe("1772409600");
  });

  it("advances the cursor to the newest record across both pages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          tickets: [{ id: 1, updated_at: "2026-03-01T00:00:00Z" }],
          end_of_stream: false,
          next_page:
            "https://acme.zendesk.com/api/v2/incremental/tickets.json?start_time=2",
        }),
      )
      .mockResolvedValueOnce(
        lastPage("tickets", [{ id: 2, updated_at: "2026-03-03T00:00:00Z" }]),
      );

    const out = await collect(zendesk.poll!(apiToken, config, "ticket", null));
    const cursors = out.map((r) => zendesk.cursorOf!("ticket", r.raw)!);
    expect(cursors.reduce((a, b) => (a > b ? a : b))).toBe(
      "2026-03-03T00:00:00Z",
    );
  });

  it("stops at end_of_stream even when a next_page is still offered", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tickets: [{ id: 1, updated_at: "2026-03-01T00:00:00Z" }],
        end_of_stream: true,
        next_page:
          "https://acme.zendesk.com/api/v2/incremental/tickets.json?start_time=2",
      }),
    );
    await collect(zendesk.poll!(apiToken, config, "ticket", null));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to follow a next_page that leaves the tenant's origin", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tickets: [{ id: 1, updated_at: "2026-03-01T00:00:00Z" }],
        end_of_stream: false,
        next_page:
          "https://evil.example.com/api/v2/incremental/tickets.json?start_time=2",
      }),
    );
    const out = await collect(zendesk.poll!(apiToken, config, "ticket", null));
    // The Authorization header must never reach another host.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
  });

  it("stops when next_page is absent or unparseable", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tickets: [{ id: 1 }],
        end_of_stream: false,
        next_page: "not a url",
      }),
    );
    await collect(zendesk.poll!(apiToken, config, "ticket", null));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("zendesk.poll — ticket comments", () => {
  const eventsPage = (events: unknown[]) => lastPage("ticket_events", events);

  it("lifts Comment children out of a ticket event and stamps them with its context", async () => {
    fetchMock.mockResolvedValue(
      eventsPage([
        {
          id: 5000,
          ticket_id: 42,
          created_at: "2026-03-02T12:00:00Z",
          child_events: [
            {
              id: 9001,
              event_type: "Comment",
              body: "Refund issued.",
              public: true,
              author_id: 200,
            },
            { id: 9002, event_type: "Change", field_name: "status" },
          ],
        },
      ]),
    );

    const out = await collect(
      zendesk.poll!(apiToken, config, "ticket_comment", null),
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.sourceRecordType).toBe("ticket_comment");
    expect(out[0]!.externalId).toBe("9001");
    // The comment child carries no ticket or timestamp of its own — the parent
    // event's are what cursorOf and normalizeRecord go on to read.
    const raw = out[0]!.raw as Record<string, unknown>;
    expect(raw["ticket_id"]).toBe(42);
    expect(raw["created_at"]).toBe("2026-03-02T12:00:00Z");
    expect(zendesk.cursorOf!("ticket_comment", raw)).toBe(
      "2026-03-02T12:00:00Z",
    );
    expect(
      zendesk.normalizeRecord("ticket_comment", raw).properties["body"],
    ).toBe("Refund issued.");
  });

  it("yields every comment across several events on a page", async () => {
    fetchMock.mockResolvedValue(
      eventsPage([
        {
          id: 1,
          ticket_id: 10,
          created_at: "2026-03-01T00:00:00Z",
          child_events: [{ id: 11, event_type: "Comment", body: "a" }],
        },
        {
          id: 2,
          ticket_id: 20,
          created_at: "2026-03-02T00:00:00Z",
          child_events: [
            { id: 21, event_type: "Comment", body: "b" },
            { id: 22, event_type: "Comment", body: "c" },
          ],
        },
      ]),
    );
    const out = await collect(
      zendesk.poll!(apiToken, config, "ticket_comment", null),
    );
    expect(out.map((r) => r.externalId)).toEqual(["11", "21", "22"]);
  });

  it("yields nothing for an event with no comment children", async () => {
    fetchMock.mockResolvedValue(
      eventsPage([
        {
          id: 1,
          ticket_id: 10,
          child_events: [{ id: 11, event_type: "Change" }],
        },
      ]),
    );
    expect(
      await collect(zendesk.poll!(apiToken, config, "ticket_comment", null)),
    ).toEqual([]);
  });

  it("tolerates an event with no child_events at all", async () => {
    fetchMock.mockResolvedValue(eventsPage([{ id: 1, ticket_id: 10 }]));
    expect(
      await collect(zendesk.poll!(apiToken, config, "ticket_comment", null)),
    ).toEqual([]);
  });
});

describe("zendesk.poll — record shaping", () => {
  it("keys records by a stringified id and preserves the raw payload", async () => {
    const raw = { id: 42, subject: "Hi", updated_at: "2026-03-02T12:00:00Z" };
    fetchMock.mockResolvedValue(lastPage("tickets", [raw]));
    const out = await collect(zendesk.poll!(apiToken, config, "ticket", null));
    expect(out).toHaveLength(1);
    expect(out[0]!.externalId).toBe("42");
    expect(out[0]!.sourceRecordType).toBe("ticket");
    expect(out[0]!.raw).toEqual(raw);
    expect(out[0]!.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips records missing an id", async () => {
    fetchMock.mockResolvedValue(
      lastPage("tickets", [{ subject: "no id" }, { id: 2 }]),
    );
    const out = await collect(zendesk.poll!(apiToken, config, "ticket", null));
    expect(out.map((r) => r.externalId)).toEqual(["2"]);
  });

  it("tolerates a response with no collection array", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ end_of_stream: true }));
    expect(
      await collect(zendesk.poll!(apiToken, config, "ticket", null)),
    ).toEqual([]);
  });
});

describe("zendesk.poll — error responses", () => {
  it("throws on an auth failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 401));
    await expect(
      collect(zendesk.poll!(apiToken, config, "ticket", null)),
    ).rejects.toThrow(/401/);
  });

  it("throws on a rate limit so the poll fails and the connection degrades", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 429));
    await expect(
      collect(zendesk.poll!(apiToken, config, "ticket", null)),
    ).rejects.toThrow(/zendesk\.poll: incremental export 429 for ticket/);
  });

  it("throws mid-pagination rather than returning a truncated batch", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          tickets: [{ id: 1, updated_at: "2026-03-01T00:00:00Z" }],
          end_of_stream: false,
          next_page:
            "https://acme.zendesk.com/api/v2/incremental/tickets.json?start_time=2",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}, false, 429));
    await expect(
      collect(zendesk.poll!(apiToken, config, "ticket", null)),
    ).rejects.toThrow(/429/);
  });
});

describe("zendesk.cursorOf", () => {
  it("returns updated_at, falling back to created_at for lifted comments", () => {
    expect(
      zendesk.cursorOf!("ticket", { updated_at: "2026-03-02T12:00:00Z" }),
    ).toBe("2026-03-02T12:00:00Z");
    expect(
      zendesk.cursorOf!("ticket_comment", {
        created_at: "2026-03-01T00:00:00Z",
      }),
    ).toBe("2026-03-01T00:00:00Z");
  });

  it("prefers updated_at when both are present", () => {
    expect(
      zendesk.cursorOf!("ticket", {
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-02T00:00:00Z",
      }),
    ).toBe("2026-03-02T00:00:00Z");
  });

  it("returns null when no watermark is present", () => {
    expect(zendesk.cursorOf!("ticket", {})).toBeNull();
    expect(zendesk.cursorOf!("ticket", null)).toBeNull();
  });
});
