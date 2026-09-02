import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linear } from "../linear/index";
import type { AuthCredential, RawRecord } from "../types";

const bearer: AuthCredential = { scheme: "bearer_token", token: "lin-oauth" };
const apiKey: AuthCredential = { scheme: "api_key", apiKey: "lin_api_key" };
const config = { syncDepthDays: 90 };

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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("linear.poll — request shape", () => {
  it("yields nothing for an unusable credential", async () => {
    const out = await collect(
      linear.poll!({ scheme: "public" }, config, "issue", null),
    );
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs GraphQL to the Linear endpoint with a Bearer header for OAuth", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { issues: { nodes: [] } } }),
    );
    await collect(linear.poll!(bearer, config, "issue", null));
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer lin-oauth",
    );
  });

  it("sends a raw Authorization header for a personal API key", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { issues: { nodes: [] } } }),
    );
    await collect(linear.poll!(apiKey, config, "issue", null));
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "lin_api_key",
    );
  });

  it("embeds the cursor as an updatedAt gt filter", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { issues: { nodes: [] } } }),
    );
    await collect(
      linear.poll!(bearer, config, "issue", "2026-04-01T00:00:00Z"),
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain('updatedAt: { gt: "2026-04-01T00:00:00Z" }');
    expect(body.query).toContain("orderBy: updatedAt");
  });

  it("returns nothing for an unpollable record type", async () => {
    const out = await collect(linear.poll!(bearer, config, "not_a_type", null));
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("linear.poll — record shaping", () => {
  it("reshapes issue labels from labels.nodes into a flat {name}[] array", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "iss_1",
                title: "Fix bug",
                updatedAt: "2026-05-01T00:00:00Z",
                labels: { nodes: [{ name: "bug" }, { name: "p1" }] },
              },
            ],
          },
        },
      }),
    );
    const out = await collect(linear.poll!(bearer, config, "issue", null));
    expect(out).toHaveLength(1);
    expect(out[0]!.externalId).toBe("iss_1");
    const raw = out[0]!.raw as { labels: unknown };
    expect(raw.labels).toEqual([{ name: "bug" }, { name: "p1" }]);
    // The reshaped record must be normalizable by the connector.
    const normalized = linear.normalizeRecord("issue", out[0]!.raw);
    expect(normalized.properties["labels"]).toEqual(["bug", "p1"]);
  });

  it("throws when GraphQL returns an errors array", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errors: [{ message: "unauthorized" }] }),
    );
    await expect(
      collect(linear.poll!(bearer, config, "issue", null)),
    ).rejects.toThrow(/unauthorized/);
  });

  it("throws on a non-ok HTTP response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));
    await expect(
      collect(linear.poll!(bearer, config, "issue", null)),
    ).rejects.toThrow(/500/);
  });
});

describe("linear.cursorOf", () => {
  it("returns updatedAt for every record type", () => {
    expect(
      linear.cursorOf!("issue", { updatedAt: "2026-05-01T00:00:00Z" }),
    ).toBe("2026-05-01T00:00:00Z");
    expect(
      linear.cursorOf!("project", { updatedAt: "2026-05-02T00:00:00Z" }),
    ).toBe("2026-05-02T00:00:00Z");
  });

  it("returns null when updatedAt is missing", () => {
    expect(linear.cursorOf!("issue", {})).toBeNull();
  });
});
