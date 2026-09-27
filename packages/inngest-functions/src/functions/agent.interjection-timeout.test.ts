// The durable interjection timeout (#3941, D8): the repository step, a sleep
// until the deadline, then the deny step. The runner is the seam
// `@oxagen/handlers` installs at boot, so these tests install a fake one and
// assert what it receives and in what order the steps run.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));

import { NonRetriableError } from "@oxagen/functions";
import {
  type InterjectionTimeoutRunner,
  setInterjectionTimeoutRunner,
} from "../lib/interjection-timeout-runner";
import {
  AGENT_INTERJECTION_RAISED_EVENT,
  agentInterjectionTimeout,
  DENY_GRACE_MS,
} from "./agent.interjection-timeout";

type Handler = (args: {
  event: { data: unknown };
  step: {
    run: (id: string, fn: () => unknown) => unknown;
    sleep: (id: string, until: string | Date) => Promise<void>;
  };
}) => Promise<unknown>;
const handler = agentInterjectionTimeout as unknown as Handler;

const DATA = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  interjectionId: "inj_0123456789abcdefghjkmn",
  expiresAt: "2026-09-26T10:30:00.000Z",
};

const order: string[] = [];
const step = {
  run: (id: string, fn: () => unknown) => {
    order.push(id);
    return fn();
  },
  sleep: vi.fn(async (id: string, _until: string | Date) => {
    order.push(id);
  }),
};

function runner(
  over: Partial<InterjectionTimeoutRunner> = {},
): InterjectionTimeoutRunner {
  return {
    resolve: vi.fn(async () => ({
      outcome: "resolved" as const,
      repository: "acme/api",
    })),
    deny: vi.fn(async () => ({
      outcome: "denied" as const,
      receiptId: "rcp_0123abc",
      commandIds: ["tcm_0123abc"],
    })),
    ...over,
  };
}

beforeEach(() => {
  order.length = 0;
  step.sleep.mockClear();
});

describe("agent.interjection-timeout", () => {
  it("triggers on the raised event, bounded per workspace", () => {
    expect(mocks.configs[0]).toEqual({
      options: {
        id: "agent/interjection-timeout",
        retries: 3,
        concurrency: { limit: 10, key: "event.data.workspaceId" },
      },
      trigger: { event: "agent/interjection.raised" },
    });
    expect(AGENT_INTERJECTION_RAISED_EVENT).toBe("agent/interjection.raised");
  });

  it("names the repository, sleeps until the deadline, then denies, in that order", async () => {
    const installed = runner();
    setInterjectionTimeoutRunner(installed);
    await expect(handler({ event: { data: DATA }, step })).resolves.toEqual({
      resolved: { outcome: "resolved", repository: "acme/api" },
      denied: {
        outcome: "denied",
        receiptId: "rcp_0123abc",
        commandIds: ["tcm_0123abc"],
      },
    });
    // A deny that settled the row does not ask again.
    expect(order).toEqual(["resolve-repository", "expiry", "deny"]);
    expect(installed.resolve).toHaveBeenCalledWith(DATA);
    expect(installed.deny).toHaveBeenCalledWith(DATA);
  });

  it("wakes at the deadline as a Date, which the provider reads as a wake time, not a duration", async () => {
    setInterjectionTimeoutRunner(runner());
    await handler({ event: { data: DATA }, step });
    const until = step.sleep.mock.calls[0]?.[1];
    expect(until).toBeInstanceOf(Date);
    expect((until as Date).toISOString()).toBe(DATA.expiresAt);
  });

  it("does nothing more when a person answered first: the runner says so", async () => {
    setInterjectionTimeoutRunner(
      runner({
        deny: vi.fn(async () => ({
          outcome: "answered" as const,
          receiptId: "rcp_person",
          commandIds: [],
        })),
      }),
    );
    await expect(
      handler({ event: { data: DATA }, step }),
    ).resolves.toMatchObject({ denied: { outcome: "answered" } });
  });

  it("asks once more past the deadline when the runner's clock reads it as not yet due", async () => {
    const deny = vi
      .fn<InterjectionTimeoutRunner["deny"]>()
      .mockResolvedValueOnce({
        outcome: "not_due",
        receiptId: null,
        commandIds: [],
      })
      .mockResolvedValueOnce({
        outcome: "denied",
        receiptId: "rcp_0123abc",
        commandIds: [],
      });
    setInterjectionTimeoutRunner(runner({ deny }));
    await expect(
      handler({ event: { data: DATA }, step }),
    ).resolves.toMatchObject({ denied: { outcome: "denied" } });
    expect(order).toEqual([
      "resolve-repository",
      "expiry",
      "deny",
      "expiry-grace",
      "deny-again",
    ]);
    const grace = step.sleep.mock.calls[1]?.[1];
    expect(grace).toBeInstanceOf(Date);
    expect((grace as Date).getTime()).toBe(
      Date.parse(DATA.expiresAt) + DENY_GRACE_MS,
    );
  });

  it("refuses a malformed event without a retry, and runs no step (negative)", async () => {
    const installed = runner();
    setInterjectionTimeoutRunner(installed);
    for (const data of [
      { ...DATA, interjectionId: "apr_x" },
      { ...DATA, expiresAt: "at half past" },
      { ...DATA, orgId: "acme" },
    ])
      await expect(handler({ event: { data }, step })).rejects.toBeInstanceOf(
        NonRetriableError,
      );
    expect(installed.resolve).not.toHaveBeenCalled();
    expect(installed.deny).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("lets a deny failure reach Inngest, which retries the step (negative)", async () => {
    setInterjectionTimeoutRunner(
      runner({ deny: () => Promise.reject(new Error("postgres gone")) }),
    );
    await expect(handler({ event: { data: DATA }, step })).rejects.toThrow(
      "postgres gone",
    );
  });
});
