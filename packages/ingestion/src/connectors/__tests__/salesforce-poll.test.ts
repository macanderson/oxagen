import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { salesforce } from "../salesforce/index";
import type { AuthCredential, RawRecord } from "../types";

const bearer: AuthCredential = { scheme: "bearer_token", token: "sf-token" };
const config = {
  instanceUrl: "https://acme.my.salesforce.com",
  objectTypes: ["Opportunity"],
  syncDepthDays: 180,
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

/** Decode the SOQL out of the query endpoint URL. */
function soqlOf(url: string): string {
  const q = new URL(url).searchParams.get("q") ?? "";
  return q;
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

describe("salesforce.poll — request shape", () => {
  it("yields nothing for an unusable credential", async () => {
    const out = await collect(
      salesforce.poll!({ scheme: "public" }, config, "Opportunity", null),
    );
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries the object with a Bearer token and no WHERE on the first poll", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ records: [] }));
    await collect(salesforce.poll!(bearer, config, "Opportunity", null));
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer sf-token",
    );
    const soql = soqlOf(url);
    expect(soql).toContain("FROM Opportunity");
    expect(soql).toContain("ORDER BY SystemModstamp ASC");
    expect(soql).not.toContain("WHERE");
  });

  it("adds a SystemModstamp > cursor predicate on incremental polls", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ records: [] }));
    await collect(
      salesforce.poll!(
        bearer,
        config,
        "Contact",
        "2026-01-01T00:00:00.000+0000",
      ),
    );
    const soql = soqlOf((fetchMock.mock.calls[0] as [string])[0]);
    expect(soql).toContain("FROM Contact");
    expect(soql).toContain("WHERE SystemModstamp > 2026-01-01T00:00:00.000Z");
  });

  it("guards the object name against SOQL injection characters", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ records: [] }));
    await collect(
      salesforce.poll!(bearer, config, "Opportunity; DROP TABLE", null),
    );
    const soql = soqlOf((fetchMock.mock.calls[0] as [string])[0]);
    expect(soql).toContain("FROM OpportunityDROPTABLE");
    expect(soql).not.toContain(";");
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 401));
    await expect(
      collect(salesforce.poll!(bearer, config, "Opportunity", null)),
    ).rejects.toThrow(/401/);
  });
});

describe("salesforce.poll — record shaping", () => {
  it("yields records keyed by Id and preserves the raw payload", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        records: [
          {
            Id: "006AAA",
            Name: "Deal A",
            SystemModstamp: "2026-02-01T00:00:00.000+0000",
          },
          {
            Id: "006BBB",
            Name: "Deal B",
            SystemModstamp: "2026-02-02T00:00:00.000+0000",
          },
        ],
      }),
    );
    const out = await collect(
      salesforce.poll!(bearer, config, "Opportunity", null),
    );
    expect(out.map((r) => r.externalId)).toEqual(["006AAA", "006BBB"]);
    expect(out[0]!.sourceRecordType).toBe("Opportunity");
  });

  it("skips records missing an Id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ records: [{ Name: "no id" }] }));
    const out = await collect(
      salesforce.poll!(bearer, config, "Opportunity", null),
    );
    expect(out).toEqual([]);
  });
});

describe("salesforce.cursorOf", () => {
  it("returns SystemModstamp, falling back to LastModifiedDate", () => {
    expect(
      salesforce.cursorOf!("Opportunity", {
        SystemModstamp: "2026-03-01T00:00:00Z",
      }),
    ).toBe("2026-03-01T00:00:00Z");
    expect(
      salesforce.cursorOf!("Opportunity", {
        LastModifiedDate: "2026-03-02T00:00:00Z",
      }),
    ).toBe("2026-03-02T00:00:00Z");
  });

  it("returns null when no watermark is present", () => {
    expect(salesforce.cursorOf!("Opportunity", {})).toBeNull();
  });
});
