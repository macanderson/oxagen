// Which GitHub deliveries can move a workspace's steering, and the sync
// request itself (ADR-184). A delivery that names the wrong branch syncs the
// wrong thing or nothing at all, and a request that drops its event leaves a
// merged record out of force until the five-minute sweep finds it.
import { describe, expect, it, vi } from "vitest";
import { logger } from "./logger";
import {
  githubDeliveryBranch,
  githubSyncTargets,
  requestSteeringSync,
  type SteeringSyncEvent,
  type SyncScope,
} from "./context.steering.sync.request";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The shared plane holds no binding head for these tests: every chain the
// routing builds resolves to no rows.
vi.mock("@oxagen/database", async (original) => {
  const real = await original<typeof import("@oxagen/database")>();
  const empty = (): unknown =>
    new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "then"
            ? (resolve: (rows: unknown[]) => void) => resolve([])
            : () => empty(),
      },
    );
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(empty()),
  };
});
// The real client is built at import. These tests inject `send`, so the
// default one must never be reached.
vi.mock("./event-client", () => ({
  eventClient: {
    send: vi.fn(() => {
      throw new Error("the default event client must not be used here");
    }),
  },
}));

const A: SyncScope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const B: SyncScope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e02",
};
const NOW = new Date("2026-09-25T12:00:00.000Z");

type MarkRequested = (scope: SyncScope, at: Date) => Promise<void>;

function deps(over: { markRequested?: MarkRequested } = {}) {
  const markRequested = vi.fn<MarkRequested>(
    over.markRequested ?? (async () => {}),
  );
  const send = vi.fn(async (_events: SteeringSyncEvent[]) => ({}));
  const now = vi.fn(() => NOW);
  return { markRequested, send, now };
}

describe("githubDeliveryBranch", () => {
  it("reads the branch a push moved", () => {
    expect(githubDeliveryBranch("push", { ref: "refs/heads/main" })).toBe(
      "main",
    );
    // A branch name with a slash keeps it; only the refs/heads/ prefix goes.
    expect(
      githubDeliveryBranch("push", { ref: "refs/heads/release/2026-09" }),
    ).toBe("release/2026-09");
  });

  it("ignores a push to a tag, and one with no ref", () => {
    // A tag is never a production branch, and must not be read as a branch
    // called "tags/v1.2.0".
    expect(
      githubDeliveryBranch("push", { ref: "refs/tags/v1.2.0" }),
    ).toBeNull();
    expect(githubDeliveryBranch("push", {})).toBeNull();
    expect(githubDeliveryBranch("push", { ref: "" })).toBeNull();
  });

  it.each(["closed", "synchronize", "reopened", "edited"])(
    "reads the base branch of a pull request that was %s",
    (action) => {
      // The base, not the head: the sync reads the branch the pull request
      // merges into, which is where the records in force live.
      expect(
        githubDeliveryBranch("pull_request", {
          action,
          pull_request: {
            base: { ref: "main" },
            head: { ref: "context/use-pnpm" },
          },
        }),
      ).toBe("main");
    },
  );

  it.each(["opened", "labeled", "assigned", "review_requested"])(
    "ignores a pull request that was %s",
    (action) => {
      // Nothing about the production branch changes on these, and a busy
      // repository sends many of them.
      expect(
        githubDeliveryBranch("pull_request", {
          action,
          pull_request: { base: { ref: "main" } },
        }),
      ).toBeNull();
    },
  );

  // Only a Context PR has a proposal to settle. Any other PR that merges into
  // the production branch arrives as its push, so its own events ask nothing.
  it.each(["closed", "synchronize", "reopened", "edited"])(
    "ignores a %s pull request that is not a Context PR",
    (action) => {
      expect(
        githubDeliveryBranch("pull_request", {
          action,
          pull_request: {
            base: { ref: "main" },
            head: { ref: "feature/login" },
          },
        }),
      ).toBeNull();
    },
  );

  it("ignores a pull request delivery with no base branch", () => {
    expect(
      githubDeliveryBranch("pull_request", {
        action: "closed",
        pull_request: {},
      }),
    ).toBeNull();
    expect(
      githubDeliveryBranch("pull_request", { action: "closed" }),
    ).toBeNull();
  });

  it.each(["issues", "ping", "installation", "check_run", ""])(
    "ignores a %s delivery, even one that carries a ref",
    (eventName) => {
      expect(
        githubDeliveryBranch(eventName, {
          ref: "refs/heads/main",
          action: "closed",
          pull_request: { base: { ref: "main" } },
        }),
      ).toBeNull();
    },
  );
});

describe("requestSteeringSync", () => {
  it("does nothing for no targets", async () => {
    const d = deps();
    await expect(requestSteeringSync([], "push", d)).resolves.toBe(0);
    expect(d.markRequested).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("stamps every target with one instant and sends one batch", async () => {
    // One instant, so two workspaces asked by one delivery show the same
    // request time. One send, so a delivery costs one call to the event
    // service whatever the number of workspaces.
    const d = deps();
    await expect(requestSteeringSync([A, B], "push", d)).resolves.toBe(2);
    expect(d.now).toHaveBeenCalledTimes(1);
    expect(d.markRequested).toHaveBeenCalledTimes(2);
    expect(d.markRequested).toHaveBeenCalledWith(A, NOW);
    expect(d.markRequested).toHaveBeenCalledWith(B, NOW);
    expect(d.markRequested.mock.calls[0]?.[1]).toBe(
      d.markRequested.mock.calls[1]?.[1],
    );
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith([
      { name: "steering/sync.requested", data: { ...A, reason: "push" } },
      { name: "steering/sync.requested", data: { ...B, reason: "push" } },
    ]);
  });

  it("stamps before it sends", async () => {
    // A page that reads the state after the sync ran must not see a
    // `requested_at` later than the sync's own write.
    const order: string[] = [];
    const d = deps({
      markRequested: async () => {
        order.push("stamp");
      },
    });
    d.send.mockImplementation(async () => {
      order.push("send");
      return {};
    });
    await requestSteeringSync([A], "merge_request", d);
    expect(order).toEqual(["stamp", "send"]);
  });

  it("still sends when a stamp fails, and logs it", async () => {
    // The stamp only tells an open page a sync is coming. The event is what
    // does the work, so a failed stamp must not cost the sync.
    const d = deps({
      markRequested: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(requestSteeringSync([A, B], "push", d)).resolves.toBe(2);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0]?.[0]).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: A.workspaceId }),
      expect.any(String),
    );
  });

  it("fails when the send fails, so the caller can log it", async () => {
    // The webhook route catches this and answers GitHub as usual; swallowing
    // it here would hide an event service outage from that log.
    const d = deps();
    d.send.mockRejectedValue(new Error("inngest 503"));
    await expect(requestSteeringSync([A], "push", d)).rejects.toThrow(
      "inngest 503",
    );
  });
});

describe("githubSyncTargets on a dedicated plane", () => {
  const PUSH = {
    ref: "refs/heads/main",
    repository: {
      id: 4242,
      full_name: "acme/platform",
      default_branch: "main",
    },
  };

  // An organization on a dedicated Postgres plane keeps its binding heads on
  // that plane, where the shared read never looks. Its workspace is found by
  // asking its own plane, and only when that plane's head approves the
  // branch the push touched.
  it("finds a dedicated-plane workspace through its own plane", async () => {
    const mainRefOnPlane = vi.fn(async (scope: SyncScope) =>
      scope.workspaceId === B.workspaceId ? "main" : null,
    );
    const targets = await githubSyncTargets(
      { eventName: "push", body: PUSH, installationId: "555" },
      { dedicatedScopes: async () => [A, B], mainRefOnPlane },
    );
    expect(targets).toEqual([B]);
    expect(mainRefOnPlane).toHaveBeenCalledWith(B, "4242");
  });

  it("asks nothing of a dedicated workspace whose head approves another branch", async () => {
    const targets = await githubSyncTargets(
      { eventName: "push", body: PUSH, installationId: "555" },
      {
        dedicatedScopes: async () => [A],
        mainRefOnPlane: async () => "production",
      },
    );
    expect(targets).toEqual([]);
  });
});
