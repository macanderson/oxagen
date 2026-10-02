// The calls the badge on a wrapped agent's pull request needs (ADR-252): a
// description written with no title, a repository label created once, and a
// label added to the pull request.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient, GitHubApiError } from "../fetch-client";

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const PR = { owner: "acme", repo: "api", number: 42 };

describe("updatePullRequest with no title", () => {
  it("patches the body alone, so a title someone changed stays", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({ number: 42, html_url: "https://github.com/acme/api/pull/42" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    await client.updatePullRequest({ ...PR, body: "new body" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/api/pulls/42");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ body: "new body" });
  });
});

describe("createLabel", () => {
  const LABEL = {
    owner: "acme",
    repo: "api",
    name: "oxagen",
    color: "09090B",
    description: "A pull request an agent opened",
  };

  it("creates the label with its color and description", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ name: "oxagen" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    await expect(client.createLabel(LABEL)).resolves.toBe("created");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/api/labels");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "oxagen",
      color: "09090B",
      description: "A pull request an agent opened",
    });
  });

  it("answers exists when the repository has the name already", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ message: "Validation Failed" }, 422)),
    );
    const client = createGitHubClient({ token: "tok" });
    await expect(client.createLabel(LABEL)).resolves.toBe("exists");
  });

  it("throws any other refusal (negative)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({ message: "Resource not accessible by integration" }, 403),
        ),
    );
    const client = createGitHubClient({ token: "tok" });
    const err = await client.createLabel(LABEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(403);
  });
});

describe("addLabels", () => {
  it("posts the labels to the issues endpoint and answers the set it carries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse([{ name: "bug" }, { name: "oxagen" }]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.addLabels({ ...PR, labels: ["oxagen"] }),
    ).resolves.toEqual(["bug", "oxagen"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/api/issues/42/labels");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ labels: ["oxagen"] });
  });
});
