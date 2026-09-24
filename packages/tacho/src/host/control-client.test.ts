/**
 * Tacho collector P1-8: `post()` cleared its abort timer as soon as `fetch`
 * resolved, before `response.text()` ever ran, so a response whose body
 * stalled past the headers had nothing bounding it. `post` never resolved,
 * the Shipper's drain never returned, and the daemon's `ticking` guard
 * (the interval driver skips a tick overlapping the one before it) stopped
 * every later tick behind the one hung request.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ControlUnreachable,
  createControlClient,
  type FetchLike,
} from "./control-client";

function client(fetch: FetchLike, timeoutMs = 5_000) {
  return createControlClient({
    endpoints: {
      ingest: "https://control.test/ingest",
      bundle: "https://control.test/bundle",
      commands: "https://control.test/commands",
    },
    apiKey: "k",
    hostEnrollmentId: "h",
    fetch,
    timeoutMs,
  });
}

describe("control client request timeout", () => {
  it("aborts a request whose connect never answers", async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      const rejection = expect(client(fetch).bundle()).rejects.toThrow(
        ControlUnreachable,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a request whose body never finishes, not only one whose connect hangs", async () => {
    vi.useFakeTimers();
    try {
      let bodyAborted = false;
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          // Headers arrived; the body stream stalls. Before the fix, the
          // abort timer was already cleared by the time this ran, so this
          // listener would never fire and the call would hang forever.
          text: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                bodyAborted = true;
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                );
              });
            }),
        });
      const rejection = expect(client(fetch).bundle()).rejects.toThrow(
        ControlUnreachable,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(bodyAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still resolves normally when the body arrives well inside the timeout", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ bundle: {}, etag: "e" }),
      });
    // Not a schema-shaped response, but the point here is only that `post`
    // resolves rather than hanging; a real bundle response is exercised
    // elsewhere.
    await expect(client(fetch).bundle()).rejects.not.toBeInstanceOf(
      ControlUnreachable,
    );
  });
});
