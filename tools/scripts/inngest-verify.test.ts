import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canaryIsVisible,
  CANARY_EVENT_NAME,
  canaryQueryUrl,
  checkKeyPosture,
  syncApp,
  syncRetryDelayMs,
  unseenCanaryComplaint,
} from "./inngest-verify";

describe("canaryIsVisible", () => {
  it("finds the canary by its public id", () => {
    expect(
      canaryIsVisible(
        [
          { id: "01OTHER", name: "x" },
          { id: "01CANARY", name: CANARY_EVENT_NAME },
        ],
        "01CANARY",
      ),
    ).toBe(true);
  });

  it("finds the canary by its internal id", () => {
    expect(canaryIsVisible([{ internal_id: "01CANARY" }], "01CANARY")).toBe(
      true,
    );
  });

  // The witness for the failure this whole script exists to catch: events sent
  // with an event key from another environment never show up here, and the
  // environment is full of unrelated traffic that must not be mistaken for them.
  it("does not report visible when the environment holds only other events", () => {
    expect(
      canaryIsVisible(
        [
          { id: "01SCHEDULED", name: "inngest/scheduled.timer" },
          { id: "01FINISHED", name: "inngest/function.finished" },
        ],
        "01CANARY",
      ),
    ).toBe(false);
  });

  // A canary from an earlier run carries the same name. Matching on the name
  // would let a mismatched key pair pass forever.
  it("does not accept a previous run's canary", () => {
    expect(
      canaryIsVisible(
        [{ id: "01EARLIER", name: CANARY_EVENT_NAME }],
        "01CANARY",
      ),
    ).toBe(false);
  });

  it("is false for an empty environment", () => {
    expect(canaryIsVisible([], "01CANARY")).toBe(false);
  });
});

describe("canaryQueryUrl", () => {
  // Unfiltered, the endpoint returns the newest events of every name, and a
  // busy production environment pushes the canary out of that page between
  // polls. The deploy of 08ed1170e failed that way with keys that had passed
  // 23 minutes earlier.
  it("asks only for canaries, received since shortly before this one was sent", () => {
    const url = new URL(canaryQueryUrl(new Date("2026-09-24T15:35:05.000Z")));
    expect(url.origin + url.pathname).toBe("https://api.inngest.com/v1/events");
    expect(url.searchParams.get("name")).toBe(CANARY_EVENT_NAME);
    expect(url.searchParams.get("received_after")).toBe(
      "2026-09-24T15:30:05.000Z",
    );
    expect(url.searchParams.get("limit")).toBe("100");
  });
});

describe("unseenCanaryComplaint", () => {
  it("reports a key mismatch when the API answered and the canary never appeared", () => {
    const message = unseenCanaryComplaint("01CANARY", null, true);
    expect(message).toContain("01CANARY");
    expect(message).toContain("belong to different Inngest environments");
  });

  // Every query failing says nothing about the keys. Calling it a mismatch
  // would send someone to rotate a pair that works.
  it("does not blame the keys when no query was answered", () => {
    const message = unseenCanaryComplaint("01CANARY", 503, false);
    expect(message).toContain("last status 503");
    expect(message).toContain("whether the keys agree is unknown");
    expect(message).not.toContain("different Inngest environments");
  });
});

describe("syncRetryDelayMs", () => {
  it("waits as long as Retry-After asks on an overloaded api", () => {
    expect(syncRetryDelayMs(503, "2")).toBe(2_000);
  });

  it("keeps the wait between one and fifteen seconds", () => {
    expect(syncRetryDelayMs(429, "0")).toBe(1_000);
    expect(syncRetryDelayMs(503, "120")).toBe(15_000);
  });

  it("waits the default when Retry-After is missing or not a number", () => {
    expect(syncRetryDelayMs(502, null)).toBe(2_000);
    expect(syncRetryDelayMs(504, "")).toBe(2_000);
    expect(syncRetryDelayMs(503, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(2_000);
  });

  it("treats a refusal from Inngest as final", () => {
    expect(syncRetryDelayMs(400, "2")).toBeNull();
    expect(syncRetryDelayMs(401, null)).toBeNull();
    expect(syncRetryDelayMs(500, null)).toBeNull();
  });
});

describe("syncApp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function overloaded(): Response {
    return new Response(
      JSON.stringify({ error: { code: "service_overloaded" } }),
      { status: 503, headers: { "Retry-After": "2" } },
    );
  }

  // The deploy of 60e2da346 (#5324) failed on the first 503 while Inngest's
  // own step calls filled the api's background lane.
  it("retries an overloaded api and succeeds once it answers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce(new Response('{"message":"Successfully registered"}'));
    const sleepImpl = vi.fn(async () => {});

    await syncApp("https://example.test/api/inngest", { fetchImpl, sleepImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(2_000);
  });

  it("fails at once when Inngest refuses the sync", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("verification refused");
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("batch size too large", { status: 400 }));
    const sleepImpl = vi.fn(async () => {});

    await expect(
      syncApp("https://example.test/api/inngest", { fetchImpl, sleepImpl }),
    ).rejects.toThrow("verification refused");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("fails once the retry budget is spent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("verification refused");
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => overloaded());
    const sleepImpl = vi.fn(async () => {});

    await expect(
      syncApp("https://example.test/api/inngest", {
        fetchImpl,
        sleepImpl,
        budgetMs: 5_000,
      }),
    ).rejects.toThrow("verification refused");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("returned 503 on attempt 3"));
  });
});

describe("production signing key posture", () => {
  it("sets production mode on the deploy verification step", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/pipeline.yml", import.meta.url),
      "utf8",
    );
    const step = workflow
      .split("- name: Sync Inngest functions and verify the key pair")[1]
      ?.split(/\n      - /)[0];
    expect(step).toMatch(/env:\s*\n\s*NODE_ENV: production/);
    expect(step).toContain("pnpm inngest:verify");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses a test signing key in the deploy environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("verification refused");
    });
    expect(() => checkKeyPosture("signkey-test-example")).toThrow(
      "verification refused",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
