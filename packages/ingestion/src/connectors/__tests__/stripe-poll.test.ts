import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripe } from "../stripe/index";
import type { AuthCredential, RawRecord } from "../types";

const secretKey: AuthCredential = {
  scheme: "api_key",
  apiKey: "sk_test_51ABCDEF",
};
const config = { syncDepthDays: 90, pageSize: 100 };

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

/** Read one query parameter out of a recorded request URL. */
function paramOf(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

function urlOfCall(index: number): string {
  return (fetchMock.mock.calls[index] as [string])[0];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stripe.poll — credential handling", () => {
  it("yields nothing for a credential scheme Stripe cannot use", async () => {
    const out = await collect(
      stripe.poll!({ scheme: "public" }, config, "customer", null),
    );
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("yields nothing for a bearer token — Stripe keys arrive as api_key", async () => {
    const bearer: AuthCredential = {
      scheme: "bearer_token",
      token: "sk_test_51ABCDEF",
    };
    expect(
      await collect(stripe.poll!(bearer, config, "customer", null)),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a key without an sk_/rk_ prefix rather than putting it on the wire", async () => {
    const publishable: AuthCredential = {
      scheme: "api_key",
      apiKey: "pk_test_51ABCDEF",
    };
    expect(
      await collect(stripe.poll!(publishable, config, "customer", null)),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a restricted key", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
    const restricted: AuthCredential = {
      scheme: "api_key",
      apiKey: "rk_live_51ABCDEF",
    };
    await collect(stripe.poll!(restricted, config, "customer", null));
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer rk_live_51ABCDEF",
    );
  });
});

describe("stripe.poll — request shape", () => {
  it("yields nothing for a record type Stripe does not list", async () => {
    expect(
      await collect(stripe.poll!(secretKey, config, "payout", null)),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls every declared record type at its own resource path", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
    const expected: Record<string, string> = {
      customer: "customers",
      charge: "charges",
      refund: "refunds",
      subscription: "subscriptions",
      invoice: "invoices",
      dispute: "disputes",
    };
    for (const [recordType, path] of Object.entries(expected)) {
      fetchMock.mockClear();
      await collect(stripe.poll!(secretKey, config, recordType, null));
      expect(new URL(urlOfCall(0)).pathname).toBe(`/v1/${path}`);
    }
  });

  it("bounds the first poll by syncDepthDays rather than fetching all history", async () => {
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    fetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
    await collect(
      stripe.poll!(secretKey, { ...config, syncDepthDays: 30 }, "charge", null),
    );
    const created = Number(paramOf(urlOfCall(0), "created[gt]"));
    const expected =
      Math.floor(Date.parse("2026-03-01T00:00:00.000Z") / 1000) - 30 * 86_400;
    expect(created).toBe(expected);
    expect(paramOf(urlOfCall(0), "limit")).toBe("100");
    vi.useRealTimers();
  });

  it("converts the ISO cursor to the epoch seconds created[gt] expects", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
    await collect(
      stripe.poll!(secretKey, config, "charge", "2023-11-14T22:13:20.000Z"),
    );
    expect(paramOf(urlOfCall(0), "created[gt]")).toBe("1700000000");
    expect(paramOf(urlOfCall(0), "starting_after")).toBeNull();
  });

  it("sends Stripe-Account only when a connected account is configured", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));

    await collect(stripe.poll!(secretKey, config, "customer", null));
    let [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.headers as Record<string, string>).not.toHaveProperty(
      "Stripe-Account",
    );

    fetchMock.mockClear();
    await collect(
      stripe.poll!(
        secretKey,
        { ...config, stripeAccount: "acct_1ABC" },
        "customer",
        null,
      ),
    );
    [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["Stripe-Account"]).toBe(
      "acct_1ABC",
    );
  });
});

describe("stripe.poll — pagination", () => {
  it("follows starting_after across a page boundary and yields both pages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: "ch_3", created: 1_700_000_300 },
            { id: "ch_2", created: 1_700_000_200 },
          ],
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "ch_1", created: 1_700_000_100 }],
          has_more: false,
        }),
      );

    const out = await collect(stripe.poll!(secretKey, config, "charge", null));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.map((r) => r.externalId)).toEqual(["ch_3", "ch_2", "ch_1"]);
    // The second request resumes after the last id of the first page.
    expect(paramOf(urlOfCall(0), "starting_after")).toBeNull();
    expect(paramOf(urlOfCall(1), "starting_after")).toBe("ch_2");
    // Both pages carry the same created[gt] window.
    expect(paramOf(urlOfCall(1), "created[gt]")).toBe(
      paramOf(urlOfCall(0), "created[gt]"),
    );
  });

  it("advances the cursor to the newest record across the whole batch", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: "ch_3", created: 1_700_000_300 },
            { id: "ch_2", created: 1_700_000_200 },
          ],
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "ch_1", created: 1_700_000_100 }],
          has_more: false,
        }),
      );

    const out = await collect(stripe.poll!(secretKey, config, "charge", null));
    // The sync loop persists MAX(cursorOf) over the batch, which must be the
    // newest record on page one — not the last record streamed.
    const cursors = out.map((r) => stripe.cursorOf!("charge", r.raw)!);
    const maxCursor = cursors.reduce((a, b) => (a > b ? a : b));
    expect(maxCursor).toBe("2023-11-14T22:18:20.000Z");
    expect(cursors.at(-1)).toBe("2023-11-14T22:15:00.000Z");
  });

  it("stops when has_more is false even though the page was full", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: "ch_1", created: 1 }], has_more: false }),
    );
    await collect(stripe.poll!(secretKey, config, "charge", null));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops instead of spinning when has_more never turns off and the page repeats", async () => {
    // A misbehaving response that always claims more with the same last id
    // would otherwise loop forever.
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: "ch_1", created: 1 }], has_more: true }),
    );
    const out = await collect(stripe.poll!(secretKey, config, "charge", null));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
  });

  it("stops on an empty page that still claims more", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: true }));
    expect(
      await collect(stripe.poll!(secretKey, config, "charge", null)),
    ).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("stripe.poll — record shaping", () => {
  it("keys records by Stripe's id and preserves the raw payload", async () => {
    const raw = { id: "cus_1", email: "a@b.com", created: 1_700_000_000 };
    fetchMock.mockResolvedValue(jsonResponse({ data: [raw], has_more: false }));
    const out = await collect(
      stripe.poll!(secretKey, config, "customer", null),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.externalId).toBe("cus_1");
    expect(out[0]!.sourceRecordType).toBe("customer");
    expect(out[0]!.raw).toEqual(raw);
    expect(out[0]!.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips records missing an id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [{ email: "no id" }, { id: "cus_2" }],
        has_more: false,
      }),
    );
    const out = await collect(
      stripe.poll!(secretKey, config, "customer", null),
    );
    expect(out.map((r) => r.externalId)).toEqual(["cus_2"]);
  });

  it("tolerates a response with no data array", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    expect(
      await collect(stripe.poll!(secretKey, config, "customer", null)),
    ).toEqual([]);
  });
});

describe("stripe.poll — error responses", () => {
  it("throws on an auth failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 401));
    await expect(
      collect(stripe.poll!(secretKey, config, "customer", null)),
    ).rejects.toThrow(/401/);
  });

  it("throws on a rate limit so the poll fails and the connection degrades", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 429));
    await expect(
      collect(stripe.poll!(secretKey, config, "charge", null)),
    ).rejects.toThrow(/stripe\.poll: list API 429 for charge/);
  });

  it("throws mid-pagination rather than returning a truncated batch", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "ch_2", created: 2 }], has_more: true }),
      )
      .mockResolvedValueOnce(jsonResponse({}, false, 429));
    await expect(
      collect(stripe.poll!(secretKey, config, "charge", null)),
    ).rejects.toThrow(/429/);
  });
});

describe("stripe.cursorOf", () => {
  it("converts Stripe's epoch-seconds created into an ISO-8601 cursor", () => {
    expect(stripe.cursorOf!("charge", { created: 1_700_000_000 })).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });

  it("returns null when created is absent or not a number", () => {
    expect(stripe.cursorOf!("charge", {})).toBeNull();
    expect(stripe.cursorOf!("charge", { created: "2023-11-14" })).toBeNull();
    expect(stripe.cursorOf!("charge", null)).toBeNull();
  });

  it("produces cursors that sort in the same order as the timestamps", () => {
    const older = stripe.cursorOf!("charge", { created: 1_700_000_000 })!;
    const newer = stripe.cursorOf!("charge", { created: 1_700_000_001 })!;
    expect(newer > older).toBe(true);
  });
});
