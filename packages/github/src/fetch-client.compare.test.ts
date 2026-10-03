// The compare reads the pull request sync makes (ADR-288): the merge base and
// files of a three-dot compare, the raw diff bytes under a byte cap, and the
// base facts a pull request read now carries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient, GitHubApiError } from "./fetch-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ARGS = { owner: "acme", repo: "api", base: BASE, head: HEAD };

function stub(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer(url, init);
    }),
  );
  return calls;
}

const client = () => createGitHubClient({ token: "t" });

describe("compareRefs", () => {
  it("answers the merge base and the files of the three-dot compare", async () => {
    const calls = stub(
      () =>
        new Response(
          JSON.stringify({
            merge_base_commit: { sha: "c".repeat(40) },
            files: [
              {
                filename: "src/a.ts",
                status: "modified",
                additions: 2,
                deletions: 1,
                changes: 3,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await expect(client().compareRefs(ARGS)).resolves.toEqual({
      mergeBaseSha: "c".repeat(40),
      files: [
        {
          path: "src/a.ts",
          previousPath: null,
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: null,
        },
      ],
      filesTruncated: false,
    });
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/acme/api/compare/${BASE}...${HEAD}`,
    );
  });

  it("says the list was cut short at GitHub's 300 files", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}`,
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
    }));
    stub(() => new Response(JSON.stringify({ files }), { status: 200 }));
    await expect(client().compareRefs(ARGS)).resolves.toMatchObject({
      mergeBaseSha: null,
      filesTruncated: true,
    });
  });
});

describe("getCompareDiff", () => {
  it("asks for the raw diff and answers its bytes as GitHub sent them", async () => {
    const bytes = new Uint8Array([0x64, 0x69, 0x66, 0x66, 0xff, 0x0a]);
    const calls = stub(() => new Response(bytes, { status: 200 }));
    const out = await client().getCompareDiff({ ...ARGS, maxBytes: 1024 });
    expect(out).toEqual({ status: "ok", bytes });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github.diff");
    expect(headers.Authorization).toBe("Bearer t");
  });

  it("stops reading past the cap and answers too_large (negative)", async () => {
    stub(() => new Response(new Uint8Array(2048), { status: 200 }));
    await expect(
      client().getCompareDiff({ ...ARGS, maxBytes: 1024 }),
    ).resolves.toEqual({ status: "too_large", reason: "over_cap" });
  });

  it.each([
    [406, "Sorry, the diff exceeded the maximum number of lines (20000)"],
    [422, "Server Error: Sorry, this diff is taking too long to generate."],
  ])("answers too_large when GitHub refuses with %i", async (status, message) => {
    stub(() => new Response(JSON.stringify({ message }), { status }));
    await expect(
      client().getCompareDiff({ ...ARGS, maxBytes: 1024 }),
    ).resolves.toEqual({ status: "too_large", reason: "forge_refused" });
  });

  it("throws a refusal that is not about size (negative)", async () => {
    stub(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    await expect(
      client().getCompareDiff({ ...ARGS, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe("getPullRequest base facts", () => {
  it("answers the base commit, the base repository's id, and when it closed", async () => {
    stub(
      () =>
        new Response(
          JSON.stringify({
            number: 42,
            title: "t",
            html_url: "https://github.com/acme/api/pull/42",
            state: "closed",
            merged: true,
            user: { login: "octo" },
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            closed_at: "2026-10-02T00:00:00Z",
            body: null,
            base: { ref: "main", sha: BASE, repo: { id: 991, full_name: "acme/api" } },
            head: { ref: "f", sha: HEAD },
          }),
          { status: 200 },
        ),
    );
    await expect(
      client().getPullRequest({ owner: "acme", repo: "api", number: 42 }),
    ).resolves.toMatchObject({
      baseSha: BASE,
      baseRepositoryId: "991",
      baseRepository: "acme/api",
      closedAt: "2026-10-02T00:00:00Z",
    });
  });
});
