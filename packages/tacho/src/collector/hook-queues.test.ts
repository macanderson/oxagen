/**
 * The ordering rules `HookQueues` promises the daemon (#4601, ADR-229): one
 * session's tasks run one at a time in arrival order, two sessions' tasks run
 * concurrently, and a host task runs alone between the tasks queued before it
 * and the tasks queued after it.
 */
import { describe, expect, it } from "vitest";
import { HookQueues } from "./hook-queues";

/** A promise the test settles by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Let every queued microtask and one timer turn run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("HookQueues", () => {
  it("runs one session's tasks one at a time, in arrival order", async () => {
    const queues = new HookQueues();
    const order: string[] = [];
    const held = gate();
    const first = queues.session("a", async () => {
      order.push("first started");
      await held.wait;
      order.push("first done");
    });
    const second = queues.session("a", async () => {
      order.push("second");
    });
    await flush();
    expect(order).toEqual(["first started"]);
    held.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["first started", "first done", "second"]);
  });

  it("runs another session's task while one session's task waits", async () => {
    const queues = new HookQueues();
    const held = gate();
    let aDone = false;
    const a = queues.session("a", async () => {
      await held.wait;
      aDone = true;
    });
    await queues.session("b", async () => undefined);
    expect(aDone).toBe(false);
    held.open();
    await a;
    expect(aDone).toBe(true);
  });

  it("starts a host task after the tasks queued before it, and holds the tasks queued after it", async () => {
    const queues = new HookQueues();
    const order: string[] = [];
    const held = gate();
    const before = queues.session("a", async () => {
      await held.wait;
      order.push("a before");
    });
    const host = queues.host(async () => {
      order.push("host");
    });
    const after = queues.session("b", async () => {
      order.push("b after");
    });
    await flush();
    expect(order).toEqual([]);
    held.open();
    await Promise.all([before, host, after]);
    expect(order).toEqual(["a before", "host", "b after"]);
  });

  it("keeps a session's order across a host task queued between its tasks", async () => {
    const queues = new HookQueues();
    const order: string[] = [];
    const held = gate();
    const first = queues.session("a", async () => {
      await held.wait;
      order.push("a1");
    });
    const host = queues.host(async () => {
      order.push("host");
    });
    const second = queues.session("a", async () => {
      order.push("a2");
    });
    held.open();
    await Promise.all([first, host, second]);
    expect(order).toEqual(["a1", "host", "a2"]);
  });

  it("goes on after a task that throws, and hands the caller the error", async () => {
    const queues = new HookQueues();
    const failed = queues.session("a", async () => {
      throw new Error("refused");
    });
    await expect(failed).rejects.toThrow("refused");
    await expect(queues.session("a", async () => "next")).resolves.toBe(
      "next",
    );
    await expect(
      queues.host(async () => {
        throw new Error("host refused");
      }),
    ).rejects.toThrow("host refused");
    await expect(queues.session("b", async () => "after")).resolves.toBe(
      "after",
    );
  });

  it("reports a session busy while its task or a host task runs, and idle once none does", async () => {
    const queues = new HookQueues();
    expect(queues.idle()).toBe(true);
    const held = gate();
    const a = queues.session("a", async () => {
      await held.wait;
    });
    await flush();
    expect(queues.busy("a")).toBe(true);
    expect(queues.busy("b")).toBe(false);
    expect(queues.idle()).toBe(false);
    held.open();
    await a;
    expect(queues.busy("a")).toBe(false);
    expect(queues.idle()).toBe(true);

    const hostHeld = gate();
    const host = queues.host(async () => {
      await hostHeld.wait;
    });
    await flush();
    expect(queues.hostBusy()).toBe(true);
    expect(queues.busy("b")).toBe(true);
    hostHeld.open();
    await host;
    expect(queues.hostBusy()).toBe(false);
    expect(queues.idle()).toBe(true);
  });
});
