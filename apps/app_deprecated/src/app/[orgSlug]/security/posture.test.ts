/**
 * loadPosture — the five live figures behind the Security overview and the
 * SOC 2 control states derived from them.
 *
 * The figures are read from `security.security_events` (policy class
 * `workspace_nullable`) and `auth.api_keys` (`standard`). Read under the
 * org-only workspace sentinel, RLS admitted only the rows carrying no
 * workspace: `deniedInvocations7d` counts capability.invoke_denied, which the
 * kernel emits with the request's real workspace, so it read 0 while the kernel
 * was denying and the tile rendered as a success; `activeApiKeys` counted only
 * keys carrying the nil sentinel; and `totalAuditEvents` decides whether CC7.2
 * reads "Active" or "Partial" and prints the count into the auditor-facing
 * rationale. RLS hides rather than refuses, so the `catch` that degrades to an
 * empty posture — the one place the page can show a figure that is not live —
 * could not fire and nothing was logged.
 *
 * `withTenantDb` is mocked inert so that regression fails here.
 *
 * The page that calls this is gated separately (assertSecurityManager on
 * security/page.tsx) — see security-page-gate.test.ts. RLS was doing that job
 * by accident while it was also breaking these figures: read under the
 * sentinel, an ordinary member saw only the org-wide rows, so nobody noticed
 * the page checked membership alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbState } = vi.hoisted(() => ({
  dbState: { queue: [] as Array<unknown[] | Error> },
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@oxagen/database", () => {
  const next = () => {
    const item = dbState.queue.shift();
    if (item instanceof Error) return Promise.reject(item);
    return Promise.resolve(item ?? []);
  };
  // Chainable and lazily awaitable: a count query ends at .where() and the
  // newest-event query ends at .limit(), so the queue is pulled when the chain
  // is awaited rather than when a link is added.
  const chain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) self[m] = () => self;
    // Both handlers: the await machinery calls then(resolve, reject), and
    // dropping the second one turns a queued failure into an unhandled
    // rejection and a hung await rather than the catch under test.
    self.then = (
      onFulfilled: (rows: unknown) => unknown,
      onRejected?: (err: unknown) => unknown,
    ) => next().then(onFulfilled, onRejected);
    return self;
  };
  return {
    withSystemDb: vi.fn((fn: (tx: unknown) => unknown) =>
      fn({ select: () => chain() }),
    ),
    withTenantDb: vi.fn(() => undefined),
    schema: {
      securityEvents: {
        orgId: "orgId",
        eventType: "eventType",
        occurredAt: "occurredAt",
        workspaceId: "workspaceId",
      },
      apiKeys: {
        orgId: "orgId",
        deletedAt: "deletedAt",
        expiresAt: "expiresAt",
      },
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  count: () => "count",
  desc: (a: unknown) => a,
  eq: (a: unknown, b: unknown) => [a, b],
  gte: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => a,
  or: (...a: unknown[]) => a,
}));

import { loadPosture } from "./posture";
import { logger } from "@oxagen/handlers/logger";

/** The five reads, in the order loadPosture makes them. */
function queue(
  failures: number,
  denied: number,
  total: number,
  latest: Date | null,
  keys: number,
) {
  dbState.queue = [
    [{ c: failures }],
    [{ c: denied }],
    [{ c: total }],
    latest === null ? [] : [{ occurredAt: latest }],
    [{ c: keys }],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.queue = [];
});

describe("loadPosture", () => {
  it("counts the denials the kernel emits with a real workspace", async () => {
    // 0 here used to be the answer whatever the kernel was doing, and the tile
    // renders tone="success" on 0 — an affirmative false claim.
    queue(3, 12, 400, new Date("2026-09-16T00:00:00.000Z"), 5);
    const posture = await loadPosture("org-1");
    expect(posture.deniedInvocations7d).toBe(12);
  });

  it("counts every active key in the org, not only sentinel-workspace ones", async () => {
    queue(0, 0, 10, null, 7);
    expect((await loadPosture("org-1")).activeApiKeys).toBe(7);
  });

  it("returns the org-wide audit total that CC7.2 is derived from", async () => {
    queue(0, 0, 1234, new Date("2026-09-16T00:00:00.000Z"), 0);
    const posture = await loadPosture("org-1");
    expect(posture.totalAuditEvents).toBe(1234);
    // The control reads Active only when this is above zero, and the count is
    // printed into the rationale an auditor reads.
    expect(posture.totalAuditEvents > 0).toBe(true);
  });

  it("carries the newest event's timestamp through", async () => {
    const at = new Date("2026-09-15T12:00:00.000Z");
    queue(1, 1, 1, at, 1);
    expect((await loadPosture("org-1")).lastEventAt).toEqual(at);
  });

  it("reads through the system seam, never the tenant-scoped one", async () => {
    const { withSystemDb, withTenantDb } = await import("@oxagen/database");
    queue(0, 0, 0, null, 0);
    await loadPosture("org-1");
    expect(withSystemDb).toHaveBeenCalled();
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("degrades to an empty posture on a real failure, and says so", async () => {
    // The one path that can now actually be reached: a database error raises,
    // unlike the narrowing it used to be written against.
    dbState.queue = [new Error("connection refused")];
    const posture = await loadPosture("org-1");
    expect(posture).toEqual({
      authFailures7d: 0,
      deniedInvocations7d: 0,
      activeApiKeys: 0,
      totalAuditEvents: 0,
      lastEventAt: null,
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
