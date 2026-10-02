// The merge queue's lock across processes (S3, #4449), over a stand-in for
// Postgres: each withSystemDb call is one transaction on its own connection,
// and pg_advisory_xact_lock waits until no other open transaction holds its
// key. Two postgresMergeLock() values stand for two processes, since each
// call takes its own transaction. merge-queue.pg.test.ts runs the same
// properties against Postgres itself.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";

const pg = vi.hoisted(() => ({
  /** The key each open transaction holds, and when it lets go. */
  locks: new Map<string, Promise<void>>(),
  statements: [] as { sql: string; params: unknown[] }[],
  /** What the next advisory lock statement throws, if anything. */
  lockError: null as unknown,
  /** What the next commit throws, if anything. */
  commitError: null as unknown,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  return {
    ...real,
    withSystemDb: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const held: string[] = [];
      let letGo: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      const tx = {
        execute: async (statement: SQL) => {
          const query = dialect.sqlToQuery(statement);
          pg.statements.push({ sql: query.sql, params: query.params });
          if (query.sql.includes("pg_advisory_xact_lock")) {
            if (pg.lockError !== null) {
              const err = pg.lockError;
              pg.lockError = null;
              throw err;
            }
            const key = String(query.params[0]);
            while (pg.locks.has(key)) await pg.locks.get(key);
            pg.locks.set(key, ended);
            held.push(key);
          }
          return [];
        },
      };
      let result: T;
      try {
        result = await fn(tx);
      } finally {
        // Commit or roll back: either way the transaction's locks go.
        for (const key of held) pg.locks.delete(key);
        letGo();
      }
      if (pg.commitError !== null) {
        const err = pg.commitError;
        pg.commitError = null;
        throw err;
      }
      return result;
    },
  };
});

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { HandlerError } from "@oxagen/oxagen";
import type { SteeringRepository } from "../context.steering.github";
import { logger } from "../logger";
import {
  inMergeQueue,
  postgresMergeLock,
  setSharedMergeLockForTests,
  type SharedMergeLock,
} from "./merge-queue";

const REPO: SteeringRepository = {
  provider: "github",
  owner: "a-intel",
  repo: "steering",
  fullName: "a-intel/steering",
  currentFullName: "a-intel/steering",
  defaultBranch: "main",
};
const KEY = "github:a-intel/steering";
const LOCK_KEY = `steering-merge-queue:${KEY}`;

/** A promise the test opens by hand. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Let every queued promise callback and timer run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The advisory lock statements, by the key each one named. */
const lockedKeys = () =>
  pg.statements
    .filter((s) => s.sql.includes("pg_advisory_xact_lock"))
    .map((s) => s.params[0]);

/** The Postgres error a lock wait that ran out raises, inside drizzle's wrapper. */
function lockTimeout(): Error {
  const cause = Object.assign(
    new Error("canceling statement due to lock timeout"),
    { code: "55P03" },
  );
  return Object.assign(new Error("Failed query: select pg_advisory_xact_lock"), {
    cause,
  });
}

beforeEach(() => {
  pg.locks.clear();
  pg.statements.length = 0;
  pg.lockError = null;
  pg.commitError = null;
  vi.mocked(logger.warn).mockClear();
});

describe("postgresMergeLock", () => {
  it("holds an advisory lock on the queue key while the merge runs, and waits a minute at most", async () => {
    const lock = postgresMergeLock();
    const value = await lock(KEY, async () => {
      expect(pg.locks.has(LOCK_KEY)).toBe(true);
      return "merged";
    });
    expect(value).toBe("merged");
    expect(pg.locks.size).toBe(0);
    expect(pg.statements).toEqual([
      {
        sql: expect.stringContaining("set_config('lock_timeout'"),
        params: ["60000"],
      },
      {
        sql: expect.stringContaining("pg_advisory_xact_lock(hashtextextended("),
        params: [LOCK_KEY],
      },
    ]);
  });

  it("runs two merges on one repository one after the other, as two processes would", async () => {
    const processA = postgresMergeLock();
    const processB = postgresMergeLock();
    const order: string[] = [];
    const hold = gate();
    const entered = gate();
    const first = processA(KEY, async () => {
      order.push("a starts");
      entered.open();
      await hold.opened;
      order.push("a ends");
      return "a";
    });
    await entered.opened;
    const second = processB(KEY, async () => {
      order.push("b runs");
      return "b";
    });
    await settle();
    // B asked Postgres for the lock and waits there while A holds it.
    expect(lockedKeys()).toEqual([LOCK_KEY, LOCK_KEY]);
    expect(order).toEqual(["a starts"]);
    hold.open();
    await expect(Promise.all([first, second])).resolves.toEqual(["a", "b"]);
    expect(order).toEqual(["a starts", "a ends", "b runs"]);
  });

  it("lets merges on two repositories run at once", async () => {
    const processA = postgresMergeLock();
    const processB = postgresMergeLock();
    const hold = gate();
    const entered = gate();
    const first = processA(KEY, async () => {
      entered.open();
      await hold.opened;
      return "a";
    });
    await entered.opened;
    // B's repository is another key, so it merges while A still holds its own.
    await expect(
      processB("github:a-intel/other", async () => "b"),
    ).resolves.toBe("b");
    expect(pg.locks.has(LOCK_KEY)).toBe(true);
    hold.open();
    await expect(first).resolves.toBe("a");
  });

  it("refuses merge_queue_busy when another merge holds the lock past the wait, and never starts the merge", async () => {
    pg.lockError = lockTimeout();
    const work = vi.fn(async () => "merged");
    const refusal = await postgresMergeLock({ waitMs: 5_000 })(KEY, work).catch(
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(HandlerError);
    expect(refusal).toMatchObject({
      code: "conflict",
      reason: "merge_queue_busy",
    });
    expect((refusal as HandlerError).message).toContain(
      `Another merge on ${KEY} held the merge queue for over 5 seconds`,
    );
    expect(work).not.toHaveBeenCalled();
    expect(pg.statements[0]?.params).toEqual(["5000"]);
  });

  it("passes on a database failure before the lock, and never starts the merge", async () => {
    pg.lockError = new Error("connection refused");
    const work = vi.fn(async () => "merged");
    await expect(postgresMergeLock()(KEY, work)).rejects.toThrow(
      "connection refused",
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("answers the merge's own error after it lets go of the lock", async () => {
    const refused = new HandlerError({
      code: "conflict",
      reason: "head_moved",
      message: "moved",
    });
    await expect(
      postgresMergeLock()(KEY, async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    expect(pg.locks.size).toBe(0);
    // The next merge takes the lock at once.
    await expect(postgresMergeLock()(KEY, async () => "next")).resolves.toBe(
      "next",
    );
  });

  it("keeps a merge that ran when the lock's transaction then fails, and logs it", async () => {
    pg.commitError = new Error("connection ended");
    await expect(postgresMergeLock()(KEY, async () => "merged")).resolves.toBe(
      "merged",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY }),
      expect.stringContaining("the merge ran, but its lock's transaction failed"),
    );
  });

  it("answers the merge's error, not the transaction's, when both fail", async () => {
    pg.commitError = new Error("connection ended");
    await expect(
      postgresMergeLock()(KEY, async () => {
        throw new Error("the host refused the merge");
      }),
    ).rejects.toThrow("the host refused the merge");
  });
});

describe("inMergeQueue across processes", () => {
  it("takes the shared lock under the repository's queue key", async () => {
    await expect(
      inMergeQueue({ ...REPO, fullName: "A-Intel/Steering" }, async () => 1),
    ).resolves.toBe(1);
    expect(lockedKeys()).toEqual([LOCK_KEY]);
  });

  it("sends only the head of this process's queue to Postgres", async () => {
    const hold = gate();
    const entered = gate();
    const order: string[] = [];
    const first = inMergeQueue(REPO, async () => {
      entered.open();
      await hold.opened;
      order.push("first");
    });
    await entered.opened;
    const second = inMergeQueue(REPO, async () => {
      order.push("second");
    });
    await settle();
    // The second call waits in this process and holds no connection yet.
    expect(lockedKeys()).toEqual([LOCK_KEY]);
    hold.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(lockedKeys()).toEqual([LOCK_KEY, LOCK_KEY]);
  });

  it("merges under the lock a test installs, and hands back the one it replaced", async () => {
    const keys: string[] = [];
    const recording: SharedMergeLock = (key, work) => {
      keys.push(key);
      return work();
    };
    const before = setSharedMergeLockForTests(recording);
    try {
      await expect(inMergeQueue(REPO, async () => "ran")).resolves.toBe("ran");
      expect(keys).toEqual([KEY]);
      expect(pg.statements).toEqual([]);
    } finally {
      expect(setSharedMergeLockForTests(before)).toBe(recording);
    }
  });
});
