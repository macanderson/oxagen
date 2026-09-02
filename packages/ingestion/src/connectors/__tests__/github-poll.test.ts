import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { github } from "../github/index";
import type { AuthCredential, RawRecord } from "../types";

const bearer: AuthCredential = { scheme: "bearer_token", token: "gh-token" };
const config = {
  owner: "oxageninc",
  repo: "oxagen-platform",
  syncDepthDays: 90,
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("github.poll — auth + request shape", () => {
  it("yields nothing when the credential has no usable token", async () => {
    const out = await collect(
      github.poll!({ scheme: "public" }, config, "pull_request", null),
    );
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a Bearer Authorization header", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await collect(github.poll!(bearer, config, "pull_request", null));
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer gh-token",
    );
  });

  it("passes the cursor as a `since` query param for commits", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await collect(
      github.poll!(bearer, config, "commit", "2026-01-01T00:00:00.000Z"),
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/commits?");
    expect(url).toContain(
      `since=${encodeURIComponent("2026-01-01T00:00:00.000Z")}`,
    );
  });

  it("accepts owner/repo pairs from the repositories[] config shape", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await collect(
      github.poll!(
        bearer,
        { repositories: ["a/b", "c/d"], syncDepthDays: 90 },
        "commit",
        null,
      ),
    );
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/repos/a/b/commits"))).toBe(true);
    expect(urls.some((u) => u.includes("/repos/c/d/commits"))).toBe(true);
  });
});

describe("github.poll — record shaping + cursor filtering", () => {
  it("yields pull_request records keyed by number", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { number: 42, updated_at: "2026-03-01T00:00:00Z" },
        { number: 41, updated_at: "2026-02-01T00:00:00Z" },
      ]),
    );
    const out = await collect(
      github.poll!(bearer, config, "pull_request", null),
    );
    expect(out.map((r) => r.externalId)).toEqual(["42", "41"]);
    expect(out[0]!.sourceRecordType).toBe("pull_request");
  });

  it("stops at the cursor for updated-desc lists", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { number: 3, updated_at: "2026-03-01T00:00:00Z" },
        { number: 2, updated_at: "2026-02-01T00:00:00Z" }, // == cursor → stop
        { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      ]),
    );
    const out = await collect(
      github.poll!(bearer, config, "pull_request", "2026-02-01T00:00:00Z"),
    );
    expect(out.map((r) => r.externalId)).toEqual(["3"]);
  });

  it("drops PRs returned by the issues endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          number: 10,
          updated_at: "2026-03-01T00:00:00Z",
          pull_request: { url: "x" },
        },
        { number: 11, updated_at: "2026-03-02T00:00:00Z" },
      ]),
    );
    const out = await collect(github.poll!(bearer, config, "issue", null));
    expect(out.map((r) => r.externalId)).toEqual(["11"]);
  });

  it("throws on a non-ok response so Inngest retries", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));
    await expect(
      collect(github.poll!(bearer, config, "pull_request", null)),
    ).rejects.toThrow(/500/);
  });
});

describe("github.cursorOf", () => {
  it("uses updated_at for pull_request / issue / repository", () => {
    expect(
      github.cursorOf!("pull_request", { updated_at: "2026-05-01T00:00:00Z" }),
    ).toBe("2026-05-01T00:00:00Z");
    expect(
      github.cursorOf!("repository", { updated_at: "2026-05-02T00:00:00Z" }),
    ).toBe("2026-05-02T00:00:00Z");
  });

  it("uses the committer/author date for commits", () => {
    expect(
      github.cursorOf!("commit", {
        commit: { committer: { date: "2026-06-01T00:00:00Z" } },
      }),
    ).toBe("2026-06-01T00:00:00Z");
    expect(
      github.cursorOf!("commit", {
        commit: { author: { date: "2026-06-02T00:00:00Z" } },
      }),
    ).toBe("2026-06-02T00:00:00Z");
  });

  it("uses published_at (then created_at) for releases", () => {
    expect(
      github.cursorOf!("release", { published_at: "2026-07-01T00:00:00Z" }),
    ).toBe("2026-07-01T00:00:00Z");
    expect(
      github.cursorOf!("release", { created_at: "2026-07-02T00:00:00Z" }),
    ).toBe("2026-07-02T00:00:00Z");
  });

  it("returns null when the watermark field is absent", () => {
    expect(github.cursorOf!("pull_request", {})).toBeNull();
  });
});
