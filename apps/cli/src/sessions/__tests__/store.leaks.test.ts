/**
 * Leak-hygiene tests for the session store's tail/watch handles: a manually
 * stopped tail must detach its abort listener from the caller's signal, so a
 * long-lived signal (one REPL-session controller spanning thousands of tails)
 * never accumulates dead listeners.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../store.js";

let root: string;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oxagen-store-leaks-"));
  store = new SessionStore({ root });
  await mkdir(join(root, "sessions"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("tail abort-listener hygiene", () => {
  it("tailEvents stop() removes the abort listener from the signal", async () => {
    const controller = new AbortController();
    await mkdir(join(root, "sessions", "s1"), { recursive: true });
    await writeFile(join(root, "sessions", "s1", "events.ndjson"), "");

    const handles = Array.from({ length: 5 }, () =>
      store.tailEvents("s1", () => {}, { signal: controller.signal }),
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(5);

    for (const h of handles) h.stop();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("watchSessions stop() removes the abort listener from the signal", () => {
    const controller = new AbortController();
    const handle = store.watchSessions(() => {}, { signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    handle.stop();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("an aborted signal still stops the tail (once semantics preserved)", async () => {
    const controller = new AbortController();
    await mkdir(join(root, "sessions", "s2"), { recursive: true });
    await writeFile(join(root, "sessions", "s2", "events.ndjson"), "");

    const handle = store.tailEvents("s2", () => {}, {
      signal: controller.signal,
    });
    controller.abort();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    handle.stop(); // idempotent after abort
  });
});
