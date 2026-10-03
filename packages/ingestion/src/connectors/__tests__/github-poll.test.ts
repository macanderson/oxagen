import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { github } from "../github/index";
import { changeEventKind } from "../../sync/change-event";
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

/**
 * Answer a repository read (`/repos/<owner>/<repo>`) with `defaultBranch`,
 * and every list read with `rows`.
 */
function repoAndList(defaultBranch: string, rows: unknown[] = []) {
  return (url: string) =>
    Promise.resolve(
      /\/repos\/[^/]+\/[^/?]+$/.test(url)
        ? jsonResponse({ id: 1, default_branch: defaultBranch })
        : jsonResponse(rows),
    );
}

/** One commit as GitHub's list-commits endpoint returns it. */
function restCommit(sha: string, date = "2026-09-27T11:30:00Z") {
  return {
    sha,
    html_url: `https://github.com/oxageninc/oxagen-platform/commit/${sha}`,
    commit: {
      message: "Add x\n\nBody",
      author: { name: "Dev", email: "dev@example.com", date },
      committer: { name: "Dev", email: "dev@example.com", date },
    },
    author: { login: "dev" },
  };
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
    fetchMock.mockImplementation(repoAndList("main"));
    await collect(
      github.poll!(bearer, config, "commit", "2026-01-01T00:00:00.000Z"),
    );
    const url = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .find((u) => u.includes("/commits?"));
    expect(url).toContain(
      `since=${encodeURIComponent("2026-01-01T00:00:00.000Z")}`,
    );
  });

  it("accepts owner/repo pairs from the repositories[] config shape", async () => {
    fetchMock.mockImplementation(repoAndList("main"));
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
  it("yields pull_request records keyed by global provider ID", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { id: 42, number: 42, updated_at: "2026-03-01T00:00:00Z" },
        { id: 41, number: 41, updated_at: "2026-02-01T00:00:00Z" },
      ]),
    );
    const out = await collect(
      github.poll!(bearer, config, "pull_request", null),
    );
    expect(out.map((r) => r.externalId)).toEqual([
      "pull_request:id:42",
      "pull_request:id:41",
    ]);
    expect(out[0]!.sourceRecordType).toBe("pull_request");
  });

  it("stops at the cursor for updated-desc lists", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { id: 3, number: 3, updated_at: "2026-03-01T00:00:00Z" },
        { id: 2, number: 2, updated_at: "2026-02-01T00:00:00Z" }, // == cursor → stop
        { id: 1, number: 1, updated_at: "2026-01-01T00:00:00Z" },
      ]),
    );
    const out = await collect(
      github.poll!(bearer, config, "pull_request", "2026-02-01T00:00:00Z"),
    );
    expect(out.map((r) => r.externalId)).toEqual(["pull_request:id:3"]);
  });

  it("drops PRs returned by the issues endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          number: 10,
          updated_at: "2026-03-01T00:00:00Z",
          pull_request: { url: "x" },
        },
        { id: 11, number: 11, updated_at: "2026-03-02T00:00:00Z" },
      ]),
    );
    const out = await collect(github.poll!(bearer, config, "issue", null));
    expect(out.map((r) => r.externalId)).toEqual(["issue:id:11"]);
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

describe("GitHub organization polling", () => {
  it("expands and deduplicates repositories while keeping equal issue numbers distinct", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/orgs/acme/repos"))
        return Promise.resolve(
          jsonResponse([{ full_name: "acme/one" }, { full_name: "acme/two" }]),
        );
      const one = url.includes("/repos/acme/one/");
      return Promise.resolve(
        jsonResponse([
          {
            id: one ? 101 : 202,
            number: 7,
            html_url: `https://github.com/acme/${one ? "one" : "two"}/issues/7`,
          },
        ]),
      );
    });
    const rows = await collect(
      github.poll!(
        bearer,
        {
          organizations: ["acme"],
          repositories: ["acme/one"],
          syncDepthDays: 90,
        },
        "issue",
        null,
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows.map((row) => row.externalId)).toEqual([
      "issue:id:101",
      "issue:id:202",
    ]);
    expect(
      rows.map((row) => github.normalizeRecord("issue", row.raw).externalId),
    ).toEqual(["issue:id:101", "issue:id:202"]);
  });

  it("reads beyond the first hundred records", async () => {
    // A saved cursor older than every record: the first read after a
    // connection reads one page, and any later read pages to the end.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({ id: i + 1, number: i + 1 })),
        ),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 101, number: 101 }]));
    const rows = await collect(
      github.poll!(bearer, config, "issue", "2000-01-01T00:00:00Z"),
    );
    expect(rows).toHaveLength(101);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("&page=2");
  });

  it("fails an incomplete list when a later page disappears", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))),
      )
      .mockResolvedValueOnce(jsonResponse({}, false, 404));
    const yielded: RawRecord[] = [];
    await expect(
      (async () => {
        for await (const row of github.poll!(
          bearer,
          config,
          "issue",
          "2000-01-01T00:00:00Z",
        ))
          yielded.push(row);
      })(),
    ).rejects.toThrow("404");
    expect(yielded).toHaveLength(100);
  });

  it("treats a first-page 404 as an unavailable repository", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 404));
    expect(await collect(github.poll!(bearer, config, "issue", null))).toEqual(
      [],
    );
  });
});

describe("incremental GitHub pagination", () => {
  const cursor = "2026-02-01T00:00:00Z";
  const changedAt = "2026-03-01T00:00:00Z";

  it.each(["issue", "pull_request"])(
    "stops %s with no changes after one full page",
    async (kind) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            updated_at: cursor,
          })),
        ),
      );
      expect(await collect(github.poll!(bearer, config, kind, cursor))).toEqual(
        [],
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["issue", "pull_request"])(
    "reads all same-timestamp new %s records across pages",
    async (kind) => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              updated_at: changedAt,
            })),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            Array.from({ length: 100 }, (_, i) => ({
              id: i + 101,
              updated_at: i === 0 ? changedAt : cursor,
            })),
          ),
        );
      const rows = await collect(github.poll!(bearer, config, kind, cursor));
      expect(rows).toHaveLength(101);
      expect(rows[100]?.externalId).toBe(`${kind}:id:101`);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("stops issue pagination at an excluded PR on the cursor boundary", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          updated_at: cursor,
          pull_request: {},
        })),
      ),
    );
    expect(
      await collect(github.poll!(bearer, config, "issue", cursor)),
    ).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("github.poll — commits carry the default branch (#5263)", () => {
  const cursor = "2026-09-27T00:00:00Z";

  it("stamps every polled commit with the default branch GitHub reports", async () => {
    // The stored config says main; the repository says trunk. The poll
    // believes the repository.
    fetchMock.mockImplementation(
      repoAndList("trunk", [restCommit("a".repeat(40)), restCommit("b".repeat(40))]),
    );
    const rows = await collect(
      github.poll!(bearer, { ...config, defaultBranch: "main" }, "commit", cursor),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.raw).toMatchObject({ git_branch: "trunk" });
      expect(
        github.normalizeRecord("commit", row.raw).properties["git_branch"],
      ).toBe("trunk");
    }
    // The list names the branch the poll stamps, so the two cannot disagree.
    const list = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .find((u) => u.includes("/commits?"));
    expect(list).toContain("sha=trunk");
  });

  it("reads the default branch of each repository it polls", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/repos/a/b")
          ? jsonResponse({ default_branch: "main" })
          : url.endsWith("/repos/c/d")
            ? jsonResponse({ default_branch: "develop" })
            : jsonResponse([restCommit(url.includes("/a/b/") ? "a".repeat(40) : "c".repeat(40))]),
      ),
    );
    const rows = await collect(
      github.poll!(
        bearer,
        { repositories: ["a/b", "c/d"], syncDepthDays: 90 },
        "commit",
        cursor,
      ),
    );
    expect(rows.map((r) => (r.raw as { git_branch?: string }).git_branch)).toEqual([
      "main",
      "develop",
    ]);
  });

  it("skips a repository GitHub no longer shows", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 404));
    expect(await collect(github.poll!(bearer, config, "commit", cursor))).toEqual(
      [],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails the poll rather than guess a branch when GitHub reports none", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));
    await expect(
      collect(github.poll!(bearer, config, "commit", cursor)),
    ).rejects.toThrow(/no default branch/);
  });

  it("fails the poll when the repository read fails, so it retries", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 502));
    await expect(
      collect(github.poll!(bearer, config, "commit", cursor)),
    ).rejects.toThrow(/502/);
  });
});

describe("github.poll — the first read after a connection", () => {
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      restCommit(i.toString(16).padStart(40, "0")),
    );

  it("reads one page of commits and marks each one backfill", async () => {
    fetchMock.mockImplementation(repoAndList("main", page(100)));
    const rows = await collect(github.poll!(bearer, config, "commit", null));
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.backfill === true)).toBe(true);
    const lists = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes("/commits?"),
    );
    expect(lists).toHaveLength(1);
  });

  it("pages past one hundred commits once a cursor exists, and marks none backfill", async () => {
    let listed = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/commits?"))
        return Promise.resolve(jsonResponse({ default_branch: "main" }));
      listed += 1;
      return Promise.resolve(jsonResponse(listed === 1 ? page(100) : page(1)));
    });
    const rows = await collect(
      github.poll!(bearer, config, "commit", "2026-09-01T00:00:00Z"),
    );
    expect(rows).toHaveLength(101);
    expect(rows.some((r) => r.backfill !== undefined)).toBe(false);
  });

  it.each(["issue", "pull_request", "release"])(
    "reads one page of %s records and marks each one backfill",
    async (kind) => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({ id: i + 1, number: i + 1 })),
        ),
      );
      const rows = await collect(github.poll!(bearer, config, kind, null));
      expect(rows).toHaveLength(100);
      expect(rows.every((r) => r.backfill === true)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("fires no branch trigger for a commit it backfills", async () => {
    fetchMock.mockImplementation(repoAndList("main", [restCommit("d".repeat(40))]));
    const [first] = await collect(github.poll!(bearer, config, "commit", null));
    const properties = github.normalizeRecord("commit", first!.raw).properties;
    // The commit matches `git_branch = 'main'`, and its node is new to the
    // graph, but a backfill write sends no change event to fire the trigger.
    expect(properties["git_branch"]).toBe("main");
    expect(
      changeEventKind({
        created: true,
        backfill: first!.backfill === true,
        properties,
        previousProperties: null,
      }),
    ).toBeNull();
  });
});

describe("a commit the webhook delivered and the poll reads again (#5263)", () => {
  const sha = "1".repeat(40);
  const url = `https://github.com/oxageninc/oxagen-platform/commit/${sha}`;
  const pushOn = (ref: string) =>
    github.parseWebhookEvent!("push", {
      ref,
      commits: [
        {
          id: sha,
          message: "Add x\n\nBody",
          url,
          // The same instant as the REST date below, with an offset.
          timestamp: "2026-09-27T07:30:00-04:00",
          author: { name: "Dev", email: "dev@example.com", username: "dev" },
          committer: { name: "Dev", email: "dev@example.com", username: "dev" },
        },
      ],
    })[0]!.record;

  async function pollOnce() {
    fetchMock.mockImplementation(repoAndList("trunk", [restCommit(sha)]));
    const [polled] = await collect(
      github.poll!(bearer, config, "commit", "2026-09-27T00:00:00Z"),
    );
    return polled!;
  }

  it("gets the same properties from both paths, so the poll fires no trigger again", async () => {
    const fromWebhook = github.normalizeRecord("commit", pushOn("refs/heads/trunk"));
    const polled = await pollOnce();
    const fromPoll = github.normalizeRecord("commit", polled.raw);
    expect(fromPoll.externalId).toBe(fromWebhook.externalId);
    expect(fromPoll.properties).toEqual(fromWebhook.properties);

    // The webhook's write creates the node and fires the trigger once.
    expect(
      changeEventKind({
        created: true,
        backfill: false,
        properties: fromWebhook.properties,
        previousProperties: null,
      }),
    ).toBe("created");
    // The poll's write finds the node holding the JSON the webhook stored.
    const stored = JSON.parse(JSON.stringify(fromWebhook.properties)) as Record<
      string,
      unknown
    >;
    expect(
      changeEventKind({
        created: false,
        backfill: polled.backfill === true,
        properties: fromPoll.properties,
        previousProperties: stored,
      }),
    ).toBeNull();
  });

  it("still fires when the poll finds the commit on the default branch after a push to another branch", async () => {
    const fromWebhook = github.normalizeRecord(
      "commit",
      pushOn("refs/heads/feat/x"),
    );
    const fromPoll = github.normalizeRecord("commit", (await pollOnce()).raw);
    expect(
      changeEventKind({
        created: false,
        backfill: false,
        properties: fromPoll.properties,
        previousProperties: JSON.parse(
          JSON.stringify(fromWebhook.properties),
        ) as Record<string, unknown>,
      }),
    ).toBe("updated");
  });
});
