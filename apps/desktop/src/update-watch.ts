/**
 * The automatic update check (#3697). The window renders the UI bundled
 * into this build and never loads app.oxagen.sh, so a web deploy cannot
 * leave it stale. Only a new build of the app changes what it shows, and a
 * new build arrives through the updater feed. The masthead's Check for
 * updates button used to be the only thing that read that feed, so an app
 * left open showed nothing new until someone clicked it.
 *
 * The watch reads the feed at launch, every hour, and when the window takes
 * focus with the last check at least 15 minutes old. When the feed offers a
 * newer version, it calls `offer` once for that version. It never
 * downloads, installs, or relaunches anything: the person's click on
 * Install does that, through `installUpdate` in updater.ts.
 *
 * Everything the watch touches in the webview (timers, the focus event, the
 * clock) comes in through `UpdateWatchEnv`, so the tests drive it directly.
 */
import type { Update } from "@tauri-apps/plugin-updater";

/** An hour between checks while the app stays open. */
export const WATCH_INTERVAL_MS = 60 * 60 * 1000;

/** A focus checks the feed only when the last check started this long ago. */
export const FOCUS_GAP_MS = 15 * 60 * 1000;

/** A newer build on the feed, and the handle Install passes to the plugin. */
export interface UpdateOffer {
  version: string;
  currentVersion: string;
  update: Update;
}

export interface UpdateWatchEnv {
  /** The version of the running app. */
  currentVersion: string;
  /**
   * Read the feed: `checkForUpdate` from updater.ts. The plugin returns a
   * handle only for a version newer than the running one, and it orders
   * pre-releases the way the feed numbers builds (ADR-158).
   */
  check: (currentVersion: string) => Promise<{ update: Update | null }>;
  /** True while an install runs or a check the person started is out. */
  paused: () => boolean;
  /** Show the prompt. Called at most once per version. */
  offer: (offer: UpdateOffer) => void;
  now: () => number;
  setInterval: (run: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  addEventListener: (type: "focus", listener: () => void) => void;
  removeEventListener: (type: "focus", listener: () => void) => void;
}

export interface UpdateWatch {
  /** Read the feed now, unless a check is already out or the watch is paused. */
  check: () => Promise<void>;
  /** A window focus: read the feed when the last check is FOCUS_GAP_MS old. */
  focus: () => Promise<void>;
  /**
   * Never offer this version. The app calls it when the person's own check
   * found the version, and when an install of it finished. After an install
   * whose relaunch failed, the running binary is still the old one, so the
   * feed keeps answering with the version already on disk.
   */
  handled: (version: string) => void;
  /**
   * Clear the timer and the focus listener. A check still out when this runs
   * offers nothing.
   */
  stop: () => void;
}

/**
 * Whether the prompt shows: the watch offered a version, the masthead still
 * holds the handle for that same version (a manual check or an install has
 * not replaced it), and no install is running.
 */
export function promptVisible(
  prompt: { version: string } | null,
  heldVersion: string | null,
  installing: boolean,
): boolean {
  return prompt !== null && heldVersion === prompt.version && !installing;
}

/** Start watching: one check now, then the timer and the focus listener. */
export function startUpdateWatch(env: UpdateWatchEnv): UpdateWatch {
  let lastStarted = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const offered = new Set<string>();

  async function run(): Promise<void> {
    try {
      const { update } = await env.check(env.currentVersion);
      if (update === null) return;
      // Once per version: Later means later, not at the next focus. A
      // result that lands after Install was clicked is dropped, so it
      // cannot replace the install's own progress. A result that lands
      // after stop() is dropped too.
      if (
        stopped ||
        update.version === env.currentVersion ||
        offered.has(update.version) ||
        env.paused()
      ) {
        // Each handle the plugin returns holds a resource in the Rust
        // process until close() frees it. A dropped handle is never used,
        // so free it here, or every hourly check leaks one.
        void update.close().catch(() => {});
        return;
      }
      offered.add(update.version);
      env.offer({
        version: update.version,
        currentVersion: env.currentVersion,
        update,
      });
    } catch {
      // A background check that fails stays quiet. An offline laptop would
      // otherwise raise an error every hour. The masthead button still
      // reports its own failures.
    }
  }

  function check(): Promise<void> {
    if (inFlight !== null) return inFlight;
    if (stopped || env.paused()) return Promise.resolve();
    lastStarted = env.now();
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function focus(): Promise<void> {
    if (env.now() - lastStarted < FOCUS_GAP_MS) return Promise.resolve();
    return check();
  }

  const onFocus = () => {
    void focus();
  };
  env.addEventListener("focus", onFocus);
  const timer = env.setInterval(() => {
    void check();
  }, WATCH_INTERVAL_MS);
  void check();

  return {
    check,
    focus,
    handled(version) {
      offered.add(version);
    },
    stop() {
      stopped = true;
      env.clearInterval(timer);
      env.removeEventListener("focus", onFocus);
    },
  };
}
