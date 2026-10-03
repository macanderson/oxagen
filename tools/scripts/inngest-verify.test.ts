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
  it("waits as long as Retry-After asks, in seconds", () => {
    expect(syncRetryDelayMs("2", 1)).toBe(2_000);
  });

  it("backs off by attempt when no Retry-After is given", () => {
    expect(syncRetryDelayMs(null, 3)).toBe(6_000);
  });

  it("caps a long Retry-After and floors a zero one", () => {
    expect(syncRetryDelayMs("600", 1)).toBe(15_000);
    expect(syncRetryDelayMs("0", 1)).toBe(1_000);
  });
});

describe("syncApp", () => {
  const url = "https://api.example.test/api/inngest";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers });
  }

  function clock() {
    let at = 0;
    return {
      now: () => at,
      sleepImpl: async (ms: number) => {
        at += ms;
      },
    };
  }

  it("retries a 503 from a starting API and succeeds once it answers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        respond(503, '{"error":{"code":"service_overloaded"}}', { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(respond(200, '{"ok":true}'));
    const time = clock();

    await syncApp(url, { fetchImpl, ...time });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(url, { method: "PUT" });
    expect(time.now()).toBe(2_000);
  });

  it("retries a connection that fails before any answer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(respond(200, "{}"));

    await syncApp(url, { fetchImpl, ...clock() });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails at once on a status that waiting cannot fix", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("verification refused");
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(respond(401, "bad signature"));

    await expect(syncApp(url, { fetchImpl, ...clock() })).rejects.toThrow("verification refused");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("gives up once the retry budget is spent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("verification refused");
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => respond(503, "overloaded", { "retry-after": "15" }));

    await expect(syncApp(url, { fetchImpl, ...clock() })).rejects.toThrow("verification refused");

    // 120 seconds of budget at 15 seconds a wait: the ninth answer has no room left.
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(error.mock.calls[0]?.[0]).toContain("returned 503");
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
