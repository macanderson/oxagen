// The merge queue's lock across processes, against Postgres (S3, #4449). It
// runs where DATABASE_URL names a database, as in CI's unit lanes. Each
// postgresMergeLock() call holds its own transaction on its own connection,
// as a second Oxagen process would.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase } from "@oxagen/database";
import { postgresMergeLock } from "./merge-queue";

afterAll(async () => {
  await closeDatabase();
});

/** A repository key no other suite uses, so parallel suites never wait on each other. */
const repositoryKey = () => `github:a-intel/steering-${crypto.randomUUID()}`;

/** A promise the test opens by hand. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("postgresMergeLock against Postgres", () => {
  it("runs two merges on one repository one after the other, on two connections", async () => {
    const key = repositoryKey();
    const order: string[] = [];
    const hold = gate();
    const entered = gate();
    const first = postgresMergeLock()(key, async () => {
      order.push("a starts");
      entered.open();
      await hold.opened;
      order.push("a ends");
    });
    await entered.opened;
    const second = postgresMergeLock()(key, async () => {
      order.push("b runs");
    });
    // B waits in Postgres for as long as A holds the lock.
    await sleep(300);
    expect(order).toEqual(["a starts"]);
    hold.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["a starts", "a ends", "b runs"]);
  });

  it("lets merges on two repositories hold their locks at once", async () => {
    const hold = gate();
    const entered = gate();
    const first = postgresMergeLock()(repositoryKey(), async () => {
      entered.open();
      await hold.opened;
      return "a";
    });
    await entered.opened;
    await expect(
      postgresMergeLock()(repositoryKey(), async () => "b"),
    ).resolves.toBe("b");
    hold.open();
    await expect(first).resolves.toBe("a");
  });

  it("refuses merge_queue_busy once the wait runs out, and never starts the merge", async () => {
    const key = repositoryKey();
    const hold = gate();
    const entered = gate();
    const first = postgresMergeLock()(key, async () => {
      entered.open();
      await hold.opened;
    });
    await entered.opened;
    let ran = false;
    await expect(
      postgresMergeLock({ waitMs: 200 })(key, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "merge_queue_busy" });
    expect(ran).toBe(false);
    hold.open();
    await first;
  });

  it("lets go of the lock when a merge throws", async () => {
    const key = repositoryKey();
    await expect(
      postgresMergeLock()(key, async () => {
        throw new Error("the host refused the merge");
      }),
    ).rejects.toThrow("the host refused the merge");
    await expect(
      postgresMergeLock({ waitMs: 200 })(key, async () => "next"),
    ).resolves.toBe("next");
  });
});
