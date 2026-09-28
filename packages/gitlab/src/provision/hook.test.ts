import { describe, expect, it } from "vitest";
import { GitLabApiError } from "../client";
import { ensureSteeringHook } from "./hook";
import { FakeGitlab } from "./testing/fake-gitlab";
import type { FakeGitlabSnapshot } from "./testing/fake-gitlab";

const GROUP = { id: 7, full_path: "acme" };
const HOOKS = "/projects/1/hooks";
const HOOK_URL = "https://oxagen.example/api/webhooks/gitlab";
const OTHER_URL = "https://ci.example/hook";

/** A fake holding one empty steering project with id 1. */
function project(): FakeGitlab {
  const fake = new FakeGitlab({ group: GROUP, bot: { user_id: 99, username: "group_7_bot" } });
  fake.seedProject({ name: "oxagen-support", description: "d" });
  return fake;
}

function ensure(fake: FakeGitlab, token = "hook-secret") {
  return ensureSteeringHook(fake.rest(), { project_id: 1, url: HOOK_URL, token });
}

/** The steering hook as `fake.hooks()` holds it, with its token. */
function steeringHook(id: number, token = "hook-secret") {
  return {
    id,
    url: HOOK_URL,
    token,
    push_events: true,
    merge_requests_events: true,
    enable_ssl_verification: true,
  };
}

async function cleanSnapshot(): Promise<FakeGitlabSnapshot> {
  const fake = project();
  await ensure(fake);
  return fake.snapshot();
}

describe("ensureSteeringHook", () => {
  it("creates one hook for push and merge request events", async () => {
    const fake = project();
    const setup = fake.writes().length;
    expect(await ensure(fake)).toEqual({ hook_id: 1, created: true });
    expect(fake.hooks(1)).toEqual([steeringHook(1)]);
    expect(fake.writes().slice(setup)).toEqual([{ method: "POST", path: HOOKS }]);
    expect(fake.calls.at(-2)).toEqual({ method: "GET", path: `${HOOKS}?per_page=100` });
  });

  it("puts a new token on the same hook on a rerun and adds no second hook", async () => {
    const fake = project();
    await ensure(fake, "old-secret");
    const setup = fake.writes().length;
    expect(await ensure(fake, "new-secret")).toEqual({ hook_id: 1, created: false });
    expect(fake.writes().slice(setup)).toEqual([{ method: "PUT", path: `${HOOKS}/1` }]);
    // GitLab never returns the token, so the test reads the fake's state.
    expect(fake.hooks(1)).toEqual([steeringHook(1, "new-secret")]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("turns the events back on for a hook someone changed by hand", async () => {
    const fake = project();
    await fake.rest().request("POST", HOOKS, {
      url: HOOK_URL,
      token: "stale",
      push_events: false,
      merge_requests_events: false,
      enable_ssl_verification: false,
    });
    expect(await ensure(fake)).toEqual({ hook_id: 1, created: false });
    expect(fake.hooks(1)).toEqual([steeringHook(1)]);
  });

  it("leaves a hook with another url alone and adds the steering hook beside it", async () => {
    const fake = project();
    await fake.rest().request("POST", HOOKS, { url: OTHER_URL, token: "other-secret" });
    expect(await ensure(fake)).toEqual({ hook_id: 2, created: true });
    expect(fake.hooks(1)).toEqual([
      {
        id: 1,
        url: OTHER_URL,
        token: "other-secret",
        push_events: true,
        merge_requests_events: false,
        enable_ssl_verification: true,
      },
      steeringHook(2),
    ]);
  });
});

describe("ensureSteeringHook when the API origin changes", () => {
  it("moves the hook to the new origin and adds no second hook", async () => {
    const fake = project();
    await fake.rest().request("POST", HOOKS, {
      url: "https://old-api.example/api/webhooks/gitlab",
      token: "old-secret",
      push_events: true,
      merge_requests_events: true,
      enable_ssl_verification: true,
    });
    const setup = fake.writes().length;
    expect(await ensure(fake)).toEqual({ hook_id: 1, created: false });
    expect(fake.writes().slice(setup)).toEqual([{ method: "PUT", path: `${HOOKS}/1` }]);
    expect(fake.hooks(1)).toEqual([steeringHook(1)]);
  });

  it("skips a hook whose url does not parse", async () => {
    const fake = project();
    await fake.rest().request("POST", HOOKS, { url: "not a url", token: "odd" });
    expect(await ensure(fake)).toEqual({ hook_id: 2, created: true });
    expect(fake.hooks(1).map((h) => h.url)).toEqual(["not a url", HOOK_URL]);
  });
});

describe("ensureSteeringHook after a failure", () => {
  it("reaches the clean state after the create fails before GitLab applies it", async () => {
    const fake = project();
    fake.failNext({ method: "POST", path: HOOKS, status: 500 });
    await expect(ensure(fake)).rejects.toMatchObject({ status: 500 });
    expect(fake.hooks(1)).toEqual([]);
    expect(await ensure(fake)).toEqual({ hook_id: 1, created: true });
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("adopts the hook on a rerun after the create answer was lost", async () => {
    const fake = project();
    fake.failNext({ method: "POST", path: HOOKS, status: 502, after: true });
    await expect(ensure(fake)).rejects.toMatchObject({ status: 502 });
    expect(await ensure(fake)).toEqual({ hook_id: 1, created: false });
    expect(fake.hooks(1)).toEqual([steeringHook(1)]);
    expect(fake.writes()).toEqual([
      { method: "POST", path: HOOKS },
      { method: "PUT", path: `${HOOKS}/1` },
    ]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("keeps the old token when the update fails, and a rerun puts the new one", async () => {
    const fake = project();
    await ensure(fake, "old-secret");
    fake.failNext({ method: "PUT", path: `${HOOKS}/1`, status: 500 });
    await expect(ensure(fake, "new-secret")).rejects.toMatchObject({ status: 500 });
    expect(fake.hooks(1)[0]?.token).toBe("old-secret");
    expect(await ensure(fake, "new-secret")).toEqual({ hook_id: 1, created: false });
    expect(fake.hooks(1)).toEqual([steeringHook(1, "new-secret")]);
  });

  it("throws GitLab's refusal of the list and writes nothing", async () => {
    const fake = project();
    const setup = fake.writes().length;
    fake.failNext({ method: "GET", path: HOOKS, status: 403 });
    const run = ensure(fake);
    await expect(run).rejects.toBeInstanceOf(GitLabApiError);
    await expect(run).rejects.toMatchObject({ status: 403 });
    expect(fake.writes()).toHaveLength(setup);
    expect(fake.hooks(1)).toEqual([]);
  });
});
