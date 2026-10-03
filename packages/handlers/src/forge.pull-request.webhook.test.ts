// What a GitHub `pull_request` delivery asks of the forge sync (ADR-288):
// one event per connected workspace, carrying the delivery's facts, with an
// id that holds for the head and GitHub's update time.
import { describe, expect, it, vi } from "vitest";
import {
  githubObservedEvents,
  requestForgePullRequestSync,
} from "./forge.pull-request.webhook";

const HEAD = "a".repeat(40);
const ONE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const TWO = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3f",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e02",
};

const BODY = {
  action: "synchronize",
  repository: { id: 991, full_name: "acme/api" },
  pull_request: {
    number: 42,
    html_url: "https://github.com/acme/api/pull/42",
    title: "Cut the release",
    user: { login: "octo" },
    state: "open",
    draft: false,
    merged: false,
    updated_at: "2026-10-02T10:00:00Z",
    base: { ref: "main", sha: "b".repeat(40), repo: { id: 991, full_name: "acme/api" } },
    head: { ref: "release/3.2", sha: HEAD },
  },
};

describe("githubObservedEvents", () => {
  it("asks once per connected workspace, with the delivery's facts", () => {
    const events = githubObservedEvents(BODY, [ONE, TWO]);
    expect(events.map((event) => event.data.workspaceId)).toEqual([
      ONE.workspaceId,
      TWO.workspaceId,
    ]);
    expect(events[0]).toMatchObject({
      name: "forge/pull-request.observed",
      id: `forge-pr-delivery:${ONE.workspaceId}:github:991:42:${HEAD}:2026-10-02T10:00:00.000Z`,
      data: {
        ...ONE,
        provider: "github",
        repository: "acme/api",
        number: 42,
        pullKey: `${ONE.workspaceId}:github:acme/api#42`,
        facts: expect.objectContaining({ headSha: HEAD, providerRepositoryId: "991" }),
      },
    });
  });

  it("asks nothing for a payload with no pull request (negative)", () => {
    expect(githubObservedEvents({ action: "opened" }, [ONE])).toEqual([]);
  });
});

describe("requestForgePullRequestSync", () => {
  it("sends one batch for every connected workspace and answers its size", async () => {
    const send = vi.fn(async () => undefined);
    const connectedScopes = vi.fn(async () => [ONE, TWO]);
    await expect(
      requestForgePullRequestSync(
        { connectedScopes, send },
        { body: BODY, installationId: "77" },
      ),
    ).resolves.toBe(2);
    expect(connectedScopes).toHaveBeenCalledWith("77");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads no connection and sends nothing for an unreadable payload (negative)", async () => {
    const send = vi.fn(async () => undefined);
    const connectedScopes = vi.fn(async () => [ONE]);
    await expect(
      requestForgePullRequestSync(
        { connectedScopes, send },
        { body: { pull_request: null }, installationId: "77" },
      ),
    ).resolves.toBe(0);
    expect(connectedScopes).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing when no workspace is connected to the installation (negative)", async () => {
    const send = vi.fn(async () => undefined);
    await expect(
      requestForgePullRequestSync(
        { connectedScopes: async () => [], send },
        { body: BODY, installationId: "77" },
      ),
    ).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
