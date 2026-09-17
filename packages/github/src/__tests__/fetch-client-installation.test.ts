import { afterEach, describe, it, expect, vi } from "vitest";
import { createGitHubClient } from "../fetch-client";

// ---------------------------------------------------------------------------
// Helpers (mirrors fetch-client.test.ts)
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

/** One `GET /installation/repositories` entry, with only the read fields set. */
function repo(n: number, over: Record<string, unknown> = {}) {
  return {
    id: 1000 + n,
    name: `repo-${n}`,
    full_name: `acme/repo-${n}`,
    html_url: `https://github.com/acme/repo-${n}`,
    default_branch: "main",
    private: true,
    owner: { login: "acme" },
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listInstallationRepositories", () => {
  it("maps each repository to the identity a binding pins, plus visibility", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        total_count: 2,
        repositories: [
          repo(1),
          repo(2, {
            private: false,
            default_branch: "trunk",
            owner: { login: "Acme-Inc" },
            full_name: "Acme-Inc/repo-2",
          }),
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createGitHubClient({
      token: "ghs_installation",
    }).listInstallationRepositories();

    expect(out.truncated).toBe(false);
    expect(out.repositories).toEqual([
      {
        id: "1001",
        owner: "acme",
        name: "repo-1",
        fullName: "acme/repo-1",
        defaultBranch: "main",
        private: true,
        htmlUrl: "https://github.com/acme/repo-1",
      },
      {
        id: "1002",
        owner: "Acme-Inc",
        name: "repo-2",
        fullName: "Acme-Inc/repo-2",
        defaultBranch: "trunk",
        private: false,
        htmlUrl: "https://github.com/acme/repo-2",
      },
    ]);
  });

  it("calls the installation endpoint with the installation token, one page of 100", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ total_count: 0, repositories: [] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await createGitHubClient({
      token: "ghs_installation",
    }).listInstallationRepositories();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    // The endpoint is scoped to the token's own installation — the caller
    // names no installation id, which is the whole point.
    expect(url).toBe(
      "https://api.github.com/installation/repositories?per_page=100&page=1",
    );
    expect(init.headers["Authorization"]).toBe("Bearer ghs_installation");
  });

  it("stops at the first under-full page rather than paying for an empty one", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        total_count: 3,
        repositories: [repo(1), repo(2), repo(3)],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createGitHubClient({
      token: "t",
    }).listInstallationRepositories();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.repositories).toHaveLength(3);
    expect(out.truncated).toBe(false);
  });

  it("walks further pages while each comes back full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => repo(i));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ total_count: 150, repositories: full }),
      )
      .mockResolvedValueOnce(
        makeResponse({ total_count: 150, repositories: [repo(900)] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createGitHubClient({
      token: "t",
    }).listInstallationRepositories();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string, unknown])[0]).toBe(
      "https://api.github.com/installation/repositories?per_page=100&page=2",
    );
    expect(out.repositories).toHaveLength(101);
    expect(out.truncated).toBe(true);
  });

  it("stops after MAX_PAGES and says so rather than hiding repositories silently", async () => {
    const full = Array.from({ length: 100 }, (_, i) => repo(i));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeResponse({ total_count: 900, repositories: full }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createGitHubClient({
      token: "t",
    }).listInstallationRepositories();

    // 5 pages × 100 = the bound; the 900-repo installation is reported as
    // truncated so the surface can point at the App's repository access.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(out.repositories).toHaveLength(500);
    expect(out.truncated).toBe(true);
  });

  it("treats a missing total_count as exactly what it walked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ repositories: [repo(1)] }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await createGitHubClient({
      token: "t",
    }).listInstallationRepositories();

    expect(out).toEqual({
      repositories: [
        {
          id: "1001",
          owner: "acme",
          name: "repo-1",
          fullName: "acme/repo-1",
          defaultBranch: "main",
          private: true,
          htmlUrl: "https://github.com/acme/repo-1",
        },
      ],
      truncated: false,
    });
  });

  it("surfaces a refusal: a user OAuth token is 403 on this endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(
          { message: "Resource not accessible by integration" },
          403,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createGitHubClient({ token: "gho_user" }).listInstallationRepositories(),
    ).rejects.toThrow(
      "GitHub API error 403: Resource not accessible by integration",
    );
  });
});
