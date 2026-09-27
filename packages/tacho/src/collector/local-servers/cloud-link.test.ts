import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createCloudLink,
  DEFAULT_NEXT_TIMEOUT_MS,
  DEFAULT_REPLY_TIMEOUT_MS,
  LOCAL_SERVERS_NEXT_PATH,
  LOCAL_SERVERS_REPLY_PATH,
  type CloudFetch,
  type CloudLink,
  type CloudLinkOptions,
  type CloudResponse,
} from "./cloud-link";
import { cloudUnreachable, LocalServerError } from "./errors";
import { callDelivery, MACHINE, newNonce, npmLaunch, signingKey } from "./test-support";
import type { Reply } from "./wire";

const ORIGIN = "https://api.oxagen.test";

const HEADERS = {
  Authorization: "Bearer machine-api-key",
  Accept: "application/json",
  "User-Agent": "oxagen-local-gateway",
  "X-Tacho-Host": MACHINE,
};

function response(status: number, text = ""): CloudResponse {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
}

function answering(answer: CloudResponse): Mock<CloudFetch> {
  return vi.fn<CloudFetch>(() => Promise.resolve(answer));
}

function link(fetch: CloudFetch, overrides?: Partial<CloudLinkOptions>): CloudLink {
  return createCloudLink({ baseUrl: `${ORIGIN}//`, apiKey: "machine-api-key", machine: MACHINE, fetch, ...overrides });
}

/** Assert a cloud_unreachable error and return the detail it carries as its cause. */
async function unreachableCause(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(LocalServerError);
  expect((error as LocalServerError).refusal()).toEqual(cloudUnreachable());
  return (error as LocalServerError).cause;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCloudLink", () => {
  it("long-polls for the next call with the machine's key and returns it parsed", async () => {
    const delivery = callDelivery({ key: signingKey(), launch: npmLaunch(), arguments: { path: "notes.md" } });
    const fetch = answering(response(200, JSON.stringify(delivery)));
    expect(await link(fetch).next()).toEqual(delivery);
    expect(fetch).toHaveBeenCalledWith(`${ORIGIN}${LOCAL_SERVERS_NEXT_PATH}`, {
      method: "GET",
      headers: HEADERS,
      body: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it("returns a discovery request", async () => {
    const delivery = { kind: "discover", id: newNonce(), launch: npmLaunch(), deadline_ms: 30_000 };
    expect(await link(answering(response(200, JSON.stringify(delivery)))).next()).toEqual(delivery);
  });

  it("returns undefined when the long-poll ends with no delivery", async () => {
    expect(await link(answering(response(204))).next()).toBeUndefined();
  });

  it("treats a delivery that is not JSON as an unreachable cloud", async () => {
    expect(await unreachableCause(link(answering(response(200, "<html>"))).next())).toBe("its delivery is not JSON");
  });

  it("treats a delivery that does not parse as an unreachable cloud", async () => {
    const cause = await unreachableCause(link(answering(response(200, JSON.stringify({ kind: "shell" })))).next());
    expect(cause).toMatch(/^its delivery does not parse \(/);
  });

  it("treats an error status as an unreachable cloud", async () => {
    expect(await unreachableCause(link(answering(response(503))).next())).toBe(
      `it answered GET ${LOCAL_SERVERS_NEXT_PATH} with 503`,
    );
  });

  const failures: [string, CloudFetch, string][] = [
    ["a fetch that throws an Error", () => Promise.reject(new Error("connect ECONNREFUSED")), "connect ECONNREFUSED"],
    ["a fetch that throws a string", () => Promise.reject("offline"), "offline"],
    [
      "a body that fails to read",
      () => Promise.resolve({ ok: true, status: 200, text: () => Promise.reject(new Error("socket hang up")) }),
      "socket hang up",
    ],
  ];
  it.each(failures)("treats %s as an unreachable cloud", async (_name, fetch, cause) => {
    expect(await unreachableCause(link(fetch).next())).toBe(cause);
  });

  it("posts a reply as JSON", async () => {
    const reply: Reply = { kind: "refused", id: newNonce(), machine: MACHINE, refusal: cloudUnreachable() };
    const fetch = answering(response(202));
    await expect(link(fetch).reply(reply)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(`${ORIGIN}${LOCAL_SERVERS_REPLY_PATH}`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(reply),
      signal: expect.any(AbortSignal),
    });
  });

  it("treats a refused reply post as an unreachable cloud", async () => {
    const reply: Reply = { kind: "refused", id: newNonce(), machine: MACHINE, refusal: cloudUnreachable() };
    expect(await unreachableCause(link(answering(response(500))).reply(reply))).toBe(
      `it answered POST ${LOCAL_SERVERS_REPLY_PATH} with 500`,
    );
  });

  it("aborts the long-poll when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<CloudFetch>((_url, init) => {
      signals.push(init.signal);
      return Promise.resolve(response(204));
    });
    await link(fetch).next(controller.signal);
    const [signal] = signals;
    expect(signal).not.toBe(controller.signal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("limits each request to its default timeout", async () => {
    expect(DEFAULT_NEXT_TIMEOUT_MS).toBe(40_000);
    expect(DEFAULT_REPLY_TIMEOUT_MS).toBe(30_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const cloud = link(answering(response(204)));
    await cloud.next();
    await cloud.reply({ kind: "refused", id: newNonce(), machine: MACHINE, refusal: cloudUnreachable() });
    expect(timeout.mock.calls).toEqual([[DEFAULT_NEXT_TIMEOUT_MS], [DEFAULT_REPLY_TIMEOUT_MS]]);
  });

  it("uses the timeouts the caller sets", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const cloud = link(answering(response(204)), { nextTimeoutMs: 5_000, replyTimeoutMs: 6_000 });
    await cloud.next();
    await cloud.reply({ kind: "refused", id: newNonce(), machine: MACHINE, refusal: cloudUnreachable() });
    expect(timeout.mock.calls).toEqual([[5_000], [6_000]]);
  });
});
