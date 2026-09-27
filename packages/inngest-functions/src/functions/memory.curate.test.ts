// `memory.curate` and `memory.curate-daily`: the curator's durable jobs
// (ADR-206). The runner is `@oxagen/handlers`' own (memory/runner.ts); here
// it is a fake, so the test holds the jobs' contract: one pass per workspace
// at a time, debounced, and one daily request per workspace with memory work.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  dedicated: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));
vi.mock("../lib/assistant-run-abandon", () => ({
  listDedicatedPlaneScopes: mocks.dedicated,
}));

type Step = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: (name: string, events: unknown) => Promise<unknown>;
};
type Handler = (ctx: { event: { data: unknown }; step: Step }) => Promise<unknown>;
type Registered = {
  config: {
    id?: string;
    concurrency?: { key?: string; limit: number };
    debounce?: { key: string };
  };
  trigger: { event?: string; cron?: string };
  handler: Handler;
};
const registered: Registered[] = [];
mocks.createFunction.mockImplementation(
  (config: Registered["config"], trigger: Registered["trigger"], handler: Handler) => {
    registered.push({ config, trigger, handler });
    return [{}];
  },
);

const { setMemoryRunner } = await import("../lib/memory-runner");
await import("./memory.curate");

const job = (id: string): Registered => {
  const found = registered.find((r) => r.config.id === id);
  if (!found) throw new Error(`${id} was not registered`);
  return found;
};

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const sendEvent = vi.fn(async () => undefined);
const step: Step = { run: (_name, fn) => fn(), sendEvent };

describe("memory.curate", () => {
  const curate = vi.fn();
  const workspaces = vi.fn();
  beforeEach(() => {
    curate.mockReset();
    workspaces.mockReset();
    mocks.dedicated.mockReset();
    sendEvent.mockClear();
    setMemoryRunner({ capture: vi.fn(), digest: vi.fn(), curate, workspaces });
  });

  it("runs one debounced pass per workspace, on the event run.reflect and the daily job send", () => {
    const { config, trigger } = job("memory.curate");
    expect(trigger.event).toBe("memory/curate.requested");
    expect(config.concurrency).toEqual({
      limit: 1,
      key: "event.data.workspaceId",
    });
    expect(config.debounce?.key).toBe("event.data.workspaceId");
  });

  it("asks the runner to curate the workspace named in the event", async () => {
    const outcome = {
      outcome: "curated",
      settled: 1,
      dropped: 2,
      pullRequest: { number: 7, url: "https://github.com/a/b/pull/7" },
    };
    curate.mockResolvedValue(outcome);
    await expect(
      job("memory.curate").handler({
        event: { data: { ...SCOPE, reason: "daily" } },
        step,
      }),
    ).resolves.toEqual(outcome);
    expect(curate).toHaveBeenCalledWith(SCOPE, expect.any(Date));
  });

  it("refuses an event that names no workspace, without a retry (negative)", async () => {
    for (const data of [{}, { orgId: "org-1" }, { workspaceId: "ws-1" }, null])
      await expect(
        job("memory.curate").handler({ event: { data }, step }),
      ).rejects.toMatchObject({ name: "NonRetriableError" });
    expect(curate).not.toHaveBeenCalled();
  });

  it("requests one pass a day for each workspace with memory work, dedicated planes included, once each", async () => {
    const { trigger, handler } = job("memory.curate-daily");
    expect(trigger.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    workspaces.mockResolvedValue([SCOPE, { orgId: "org-2", workspaceId: "ws-2" }]);
    mocks.dedicated.mockResolvedValue([
      { orgId: "org-2", workspaceId: "ws-2" },
      { orgId: "org-3", workspaceId: "ws-3" },
    ]);
    await expect(handler({ event: { data: {} }, step })).resolves.toEqual({
      requested: 3,
    });
    expect(sendEvent).toHaveBeenCalledWith("request-curates", [
      { name: "memory/curate.requested", data: { ...SCOPE, reason: "daily" } },
      {
        name: "memory/curate.requested",
        data: { orgId: "org-2", workspaceId: "ws-2", reason: "daily" },
      },
      {
        name: "memory/curate.requested",
        data: { orgId: "org-3", workspaceId: "ws-3", reason: "daily" },
      },
    ]);
  });

  it("sends nothing when no workspace has memory work", async () => {
    workspaces.mockResolvedValue([]);
    mocks.dedicated.mockResolvedValue([]);
    await expect(
      job("memory.curate-daily").handler({ event: { data: {} }, step }),
    ).resolves.toEqual({ requested: 0 });
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
