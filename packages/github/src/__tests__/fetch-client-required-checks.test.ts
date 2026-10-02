import { afterEach, describe, it, expect, vi } from "vitest";
import { createGitHubClient } from "../fetch-client";

// ---------------------------------------------------------------------------
// Helpers (mirrors fetch-client-read.test.ts)
// ---------------------------------------------------------------------------

type JsonBody =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

function makeResponse(body: JsonBody, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `GET /branches/{branch}` body with the given protection fields. */
function branch(fields: Record<string, unknown>) {
  return {
    name: "main",
    commit: { sha: "abc123", commit: { tree: { sha: "t" } } },
    protection_url:
      "https://api.github.com/repos/acme/widgets/branches/main/protection",
    ...fields,
  };
}

/** A protected branch whose summary requires these checks. */
function protectedBranch(
  contexts: string[],
  checks: string[] = contexts,
  enforcementLevel = "non_admins",
) {
  return branch({
    protected: true,
    protection: {
      enabled: true,
      required_status_checks: {
        enforcement_level: enforcementLevel,
        contexts,
        checks: checks.map((context) => ({ context, app_id: null })),
      },
    },
  });
}

/** An unprotected branch, as GitHub reports one. */
const unprotectedBody = branch({
  protected: false,
  protection: {
    enabled: false,
    required_status_checks: {
      enforcement_level: "off",
      contexts: [],
      checks: [],
    },
  },
});

const unprotected = makeResponse(unprotectedBody);

/** One rule from `GET /rules/branches/{branch}`. */
function rule(type: string, parameters?: Record<string, unknown>) {
  return {
    type,
    ruleset_source_type: "Repository",
    ruleset_source: "acme/widgets",
    ruleset_id: 7,
    ...(parameters === undefined ? {} : { parameters }),
  };
}

function requiredChecksRule(...contexts: string[]) {
  return rule("required_status_checks", {
    strict_required_status_checks_policy: false,
    do_not_enforce_on_create: false,
    required_status_checks: contexts.map((context) => ({
      context,
      integration_id: 15368,
    })),
  });
}

const args = { owner: "acme", repo: "widgets", branch: "main" };

const none = {
  ok: true,
  names: [],
  sources: { protection: false, rulesets: false },
};

// ---------------------------------------------------------------------------
// getRequiredStatusChecks
// ---------------------------------------------------------------------------

describe("getRequiredStatusChecks", () => {
  it("merges protection and ruleset names, without duplicates and sorted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(
          protectedBranch(["test", "checks"], ["checks", "legacy/ci"]),
        ),
      )
      .mockResolvedValueOnce(
        makeResponse([
          rule("deletion"),
          requiredChecksRule("test", "atlas-validate"),
          rule("pull_request", { required_approving_review_count: 1 }),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: true,
      names: ["atlas-validate", "checks", "legacy/ci", "test"],
      sources: { protection: true, rulesets: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://api.github.com/repos/acme/widgets/branches/main",
      "https://api.github.com/repos/acme/widgets/rules/branches/main?per_page=100&page=1",
    ]);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.method).toBe("GET");
    }
  });

  it("answers none required for an unprotected branch that no rule requires a check on", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(unprotected)
        .mockResolvedValueOnce(
          makeResponse([
            rule("non_fast_forward"),
            rule("pull_request", { required_approving_review_count: 1 }),
          ]),
        ),
    );
    const client = createGitHubClient({ token: "tok" });

    await expect(client.getRequiredStatusChecks(args)).resolves.toEqual(none);
  });

  it("answers none required when protection's enforcement level is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse(protectedBranch(["test"], ["test"], "off")),
        )
        .mockResolvedValueOnce(makeResponse([])),
    );
    const client = createGitHubClient({ token: "tok" });

    await expect(client.getRequiredStatusChecks(args)).resolves.toEqual(none);
  });

  it("answers none required when the protection summary has no required_status_checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse(branch({ protected: true, protection: { enabled: true } })),
        )
        .mockResolvedValueOnce(makeResponse([])),
    );
    const client = createGitHubClient({ token: "tok" });

    await expect(client.getRequiredStatusChecks(args)).resolves.toEqual(none);
  });

  it("counts an enforcement level it does not know as enforced", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse(protectedBranch(["test"], ["test"], "admins_only")),
        )
        .mockResolvedValueOnce(makeResponse([])),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: true,
      names: ["test"],
      sources: { protection: true, rulesets: false },
    });
  });

  it("fails when a protected branch comes back with no protection summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse(branch({ protected: true })))
        .mockResolvedValueOnce(makeResponse([])),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({ ok: false, reason: "protection summary unreadable" });
    expect("names" in out).toBe(false);
  });

  it("reads names from rulesets alone when the branch has no classic protection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(unprotected)
        .mockResolvedValueOnce(makeResponse([requiredChecksRule("test")])),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: true,
      names: ["test"],
      sources: { protection: false, rulesets: true },
    });
  });

  it("fails when the branch read answers 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ message: "Branch not found" }, 404))
        .mockResolvedValueOnce(makeResponse([])),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({ ok: false, reason: "protection read failed: 404" });
    expect("names" in out).toBe(false);
  });

  it("fails when the branch read answers 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({ message: "Resource not accessible by integration" }, 403),
        )
        .mockResolvedValueOnce(makeResponse([])),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({ ok: false, reason: "protection read failed: 403" });
    expect("names" in out).toBe(false);
  });

  it.each([
    [
      "contexts that is not an array",
      branch({
        protected: true,
        protection: {
          enabled: true,
          required_status_checks: {
            enforcement_level: "everyone",
            contexts: "test",
          },
        },
      }),
    ],
    ["no protected flag", branch({})],
    [
      "a protection summary that is not an object",
      branch({ protected: true, protection: "on" }),
    ],
    [
      "no enforcement level",
      branch({
        protected: true,
        protection: {
          enabled: true,
          required_status_checks: { contexts: ["test"] },
        },
      }),
    ],
  ])(
    "fails on a branch body with %s",
    async (_label, body) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(makeResponse(body))
          .mockResolvedValueOnce(makeResponse([])),
      );
      const client = createGitHubClient({ token: "tok" });

      const out = await client.getRequiredStatusChecks(args);

      expect(out).toEqual({
        ok: false,
        reason: "protection read failed: malformed body",
      });
      expect("names" in out).toBe(false);
    },
  );

  it("fails when rulesets answer 404, even with the branch unprotected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(unprotected)
        .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404)),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({ ok: false, reason: "rulesets read failed: 404" });
    expect("names" in out).toBe(false);
  });

  it("fails when rulesets answer 500, even with protection names in hand", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse(protectedBranch(["test"])))
        .mockResolvedValueOnce(
          makeResponse({ message: "Server Error" }, 500),
        ),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({ ok: false, reason: "rulesets read failed: 500" });
    expect("names" in out).toBe(false);
  });

  it("names both reads when both fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ message: "Forbidden" }, 403))
        .mockResolvedValueOnce(makeResponse({ message: "Server Error" }, 502)),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: false,
      reason: "protection read failed: 403; rulesets read failed: 502",
    });
  });

  it("fails on a network error instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(makeResponse([])),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: false,
      reason: "protection read failed: fetch failed",
    });
  });

  it("reads every page of rules and names the checks on each", async () => {
    const firstPage = [
      requiredChecksRule("build"),
      ...Array.from({ length: 99 }, () => rule("deletion")),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unprotected)
      .mockResolvedValueOnce(makeResponse(firstPage))
      .mockResolvedValueOnce(
        makeResponse([rule("creation"), requiredChecksRule("e2e", "build")]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: true,
      names: ["build", "e2e"],
      sources: { protection: false, rulesets: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rulePages = fetchMock.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname.includes("/rules/branches/"))
      .map((url) => url.searchParams.get("page"));
    expect(rulePages).toEqual(["1", "2"]);
  });

  it("fails when the tenth page of rules is full, since an eleventh may require a check", async () => {
    const fullPage = Array.from({ length: 100 }, () => rule("deletion"));
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.includes("/rules/branches/")
        ? makeResponse(fullPage)
        : makeResponse(unprotectedBody),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: false,
      reason: "rulesets read failed: more than 10 pages",
    });
    // One branch read and ten rule pages; an eleventh page is never asked for.
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("encodes a branch name that contains a slash as one segment", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unprotected)
      .mockResolvedValueOnce(makeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.getRequiredStatusChecks({
      owner: "acme",
      repo: "widgets",
      branch: "release/2026",
    });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://api.github.com/repos/acme/widgets/branches/release%2F2026",
      "https://api.github.com/repos/acme/widgets/rules/branches/release%2F2026?per_page=100&page=1",
    ]);
  });

  it("fails on a required_status_checks rule with no list of checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(unprotected)
        .mockResolvedValueOnce(
          makeResponse([
            rule("required_status_checks", {
              strict_required_status_checks_policy: false,
            }),
          ]),
        ),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: false,
      reason: "rulesets read failed: malformed body",
    });
  });

  it("fails on a rules body that is not an array", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(unprotected)
        .mockResolvedValueOnce(makeResponse({ rules: [] })),
    );
    const client = createGitHubClient({ token: "tok" });

    const out = await client.getRequiredStatusChecks(args);

    expect(out).toEqual({
      ok: false,
      reason: "rulesets read failed: malformed body",
    });
  });

  it("throws the caller's cancellation rather than answering a failed read", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({
      token: "tok",
      signal: controller.signal,
    });

    await expect(client.getRequiredStatusChecks(args)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
