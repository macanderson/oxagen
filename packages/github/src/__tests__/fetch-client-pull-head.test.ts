// getPullRequest carries the repository that holds the head branch (#4511),
// so a reader of a fork pull request can look its branch up in the fork.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../fetch-client";

function makeResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const pull = (head: Record<string, unknown>) => ({
  number: 7,
  title: "Add x",
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  merged: false,
  user: null,
  created_at: "2026-09-27T10:00:00Z",
  updated_at: "2026-09-27T10:30:00Z",
  body: null,
  base: { ref: "main", repo: { full_name: "acme/app" } },
  head: { ref: "feat/x", sha: "abc123", ...head },
});

async function read(head: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(makeResponse(pull(head))));
  return createGitHubClient({ token: "tok" }).getPullRequest({
    owner: "acme",
    repo: "app",
    number: 7,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPullRequest head repository", () => {
  it("names the fork that holds the head branch", async () => {
    const pr = await read({ repo: { full_name: "forker/app-fork" } });
    expect(pr.headRepository).toBe("forker/app-fork");
    expect(pr.headRef).toBe("feat/x");
  });

  it("names the base repository for a pull request from a branch in it", async () => {
    expect((await read({ repo: { full_name: "acme/app" } })).headRepository).toBe(
      "acme/app",
    );
  });

  it("reads null once the fork is deleted", async () => {
    expect((await read({ repo: null })).headRepository).toBeNull();
  });

  it("leaves the field out when the response does not say", async () => {
    expect("headRepository" in (await read({}))).toBe(false);
  });
});
