import type { Update } from "@tauri-apps/plugin-updater";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateOffer, UpdateWatchEnv } from "./update-watch";

const relaunch = vi.fn(async () => {});
const check = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));

const { checkForUpdate } = await import("./updater");
const { FOCUS_GAP_MS, promptVisible, startUpdateWatch, WATCH_INTERVAL_MS } =
  await import("./update-watch");

const RUNNING = "2.1.1";

/**
 * A plugin handle whose install must never run on its own. `close` frees the
 * resource the plugin holds for it in the Rust process.
 */
function handle(version: string) {
  return {
    version,
    currentVersion: RUNNING,
    downloadAndInstall: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as Update & {
    downloadAndInstall: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

/**
 * The webview as the watch sees it: a clock the test moves, one interval
 * the test fires, and the focus listener the test calls.
 */
function fakeEnv(overrides: Partial<UpdateWatchEnv> = {}) {
  const offers: UpdateOffer[] = [];
  const page = {
    time: 0,
    tick: null as (() => void) | null,
    tickMs: 0,
    cleared: [] as number[],
    focus: null as (() => void) | null,
    removed: null as (() => void) | null,
    paused: false,
  };
  const env: UpdateWatchEnv = {
    currentVersion: RUNNING,
    check: checkForUpdate,
    paused: () => page.paused,
    offer: (offer) => offers.push(offer),
    now: () => page.time,
    setInterval: (run, ms) => {
      page.tick = run;
      page.tickMs = ms;
      return 7;
    },
    clearInterval: (id) => page.cleared.push(id),
    addEventListener: (_type, listener) => {
      page.focus = listener;
    },
    removeEventListener: (_type, listener) => {
      page.removed = listener;
    },
    ...overrides,
  };
  return { env, offers, page };
}

/** Let the launch check, which the watch starts without awaiting, settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  check.mockReset();
  relaunch.mockClear();
});

describe("the prompt", () => {
  it("fires at launch when the feed has a newer version, and installs nothing", async () => {
    const offered = handle("2.2.0");
    check.mockResolvedValue(offered);
    const { env, offers } = fakeEnv();

    startUpdateWatch(env);
    await settle();

    expect(offers).toEqual([
      { version: "2.2.0", currentVersion: RUNNING, update: offered },
    ]);
    // The prompt asks. Only the person's click on Install downloads and
    // relaunches.
    expect(offered.downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    // The prompt holds the handle for Install, so the watch keeps it open.
    expect(offered.close).not.toHaveBeenCalled();
  });

  it("does not fire when the feed has the running version", async () => {
    // The plugin answers null when the feed is not newer.
    check.mockResolvedValue(null);
    const { env, offers } = fakeEnv();

    startUpdateWatch(env);
    await settle();

    expect(check).toHaveBeenCalledTimes(1);
    expect(offers).toEqual([]);
  });

  it("does not fire for a handle that names the running version", async () => {
    const running = handle(RUNNING);
    check.mockResolvedValue(running);
    const { env, offers } = fakeEnv();

    startUpdateWatch(env);
    await settle();

    expect(offers).toEqual([]);
    expect(running.close).toHaveBeenCalledTimes(1);
  });

  it("fires once per version, and again for a newer one", async () => {
    check.mockResolvedValue(handle("2.2.0"));
    const { env, offers, page } = fakeEnv();
    const watch = startUpdateWatch(env);
    await settle();

    const again = handle("2.2.0");
    check.mockResolvedValue(again);
    page.tick?.();
    await settle();
    expect(offers.map((o) => o.version)).toEqual(["2.2.0"]);
    // The second handle for 2.2.0 is dropped, so its resource is freed.
    expect(again.close).toHaveBeenCalledTimes(1);

    check.mockResolvedValue(handle("2.3.0"));
    await watch.check();
    expect(offers.map((o) => o.version)).toEqual(["2.2.0", "2.3.0"]);
  });
});

describe("when the watch reads the feed", () => {
  it("reads it again every hour", async () => {
    check.mockResolvedValue(null);
    const { env, page } = fakeEnv();
    startUpdateWatch(env);
    await settle();

    expect(page.tickMs).toBe(WATCH_INTERVAL_MS);
    page.tick?.();
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("reads it on focus only when the last check is 15 minutes old", async () => {
    check.mockResolvedValue(null);
    const { env, page } = fakeEnv();
    startUpdateWatch(env);
    await settle();

    page.time = FOCUS_GAP_MS - 1;
    page.focus?.();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);

    page.time = FOCUS_GAP_MS;
    page.focus?.();
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("runs one check at a time", async () => {
    let answer: (value: null) => void = () => {};
    check.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { env } = fakeEnv();
    const watch = startUpdateWatch(env);

    const joined = watch.check();
    expect(check).toHaveBeenCalledTimes(1);
    answer(null);
    await joined;
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the feed cannot be read, and tries again later", async () => {
    check.mockRejectedValue(new Error("Could not fetch a valid release JSON"));
    const { env, offers, page } = fakeEnv();
    startUpdateWatch(env);
    await settle();
    expect(offers).toEqual([]);

    check.mockResolvedValue(handle("2.2.0"));
    page.tick?.();
    await settle();
    expect(offers.map((o) => o.version)).toEqual(["2.2.0"]);
  });
});

describe("an install or a manual check in progress", () => {
  it("holds the watch off the feed", async () => {
    check.mockResolvedValue(handle("2.2.0"));
    const { env, offers, page } = fakeEnv();
    page.paused = true;
    const watch = startUpdateWatch(env);

    await watch.check();
    expect(check).not.toHaveBeenCalled();
    expect(offers).toEqual([]);
  });

  it("drops a result that lands after Install was clicked, and offers it later", async () => {
    let answer: (value: Update) => void = () => {};
    check.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { env, offers, page } = fakeEnv();
    const watch = startUpdateWatch(env);

    page.paused = true;
    const late = handle("2.2.0");
    answer(late);
    await settle();
    expect(offers).toEqual([]);
    expect(late.close).toHaveBeenCalledTimes(1);

    page.paused = false;
    check.mockResolvedValue(handle("2.2.0"));
    await watch.check();
    expect(offers.map((o) => o.version)).toEqual(["2.2.0"]);
  });
});

describe("stop", () => {
  it("clears the timer and removes the same focus listener it added", async () => {
    check.mockResolvedValue(null);
    const { env, page } = fakeEnv();
    const watch = startUpdateWatch(env);
    await settle();

    watch.stop();
    expect(page.cleared).toEqual([7]);
    expect(page.removed).toBe(page.focus);
  });

  it("drops a check that was out when it ran, and starts no new one", async () => {
    let answer: (value: Update) => void = () => {};
    check.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { env, offers } = fakeEnv();
    const watch = startUpdateWatch(env);

    watch.stop();
    const late = handle("2.2.0");
    answer(late);
    await settle();
    expect(offers).toEqual([]);
    expect(late.close).toHaveBeenCalledTimes(1);

    await watch.check();
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("a version the app already handled", () => {
  it("is not offered after the person's own check found it", async () => {
    check.mockResolvedValue(null);
    const { env, offers } = fakeEnv();
    const watch = startUpdateWatch(env);
    await settle();

    watch.handled("2.2.0");
    const same = handle("2.2.0");
    check.mockResolvedValue(same);
    await watch.check();

    expect(offers).toEqual([]);
    expect(same.close).toHaveBeenCalledTimes(1);
  });

  it("is not offered again after an install whose relaunch failed", async () => {
    check.mockResolvedValue(handle("2.2.0"));
    const { env, offers } = fakeEnv();
    const watch = startUpdateWatch(env);
    await settle();
    expect(offers.map((o) => o.version)).toEqual(["2.2.0"]);

    // The install finished and the relaunch failed, so the app still runs
    // 2.1.1 and the feed still answers 2.2.0.
    watch.handled("2.2.0");
    check.mockResolvedValue(handle("2.2.0"));
    await watch.check();
    expect(offers.map((o) => o.version)).toEqual(["2.2.0"]);

    check.mockResolvedValue(handle("2.3.0"));
    await watch.check();
    expect(offers.map((o) => o.version)).toEqual(["2.2.0", "2.3.0"]);
  });
});

describe("promptVisible", () => {
  const prompt = { version: "2.2.0" };

  it("shows the prompt while the masthead holds the offered version", () => {
    expect(promptVisible(prompt, "2.2.0", false)).toBe(true);
  });

  it("hides it after Later", () => {
    expect(promptVisible(null, "2.2.0", false)).toBe(false);
  });

  it("hides it while the install runs", () => {
    expect(promptVisible(prompt, "2.2.0", true)).toBe(false);
  });

  it("hides it when a later check replaced or cleared the handle", () => {
    expect(promptVisible(prompt, "2.3.0", false)).toBe(false);
    expect(promptVisible(prompt, null, false)).toBe(false);
  });
});
