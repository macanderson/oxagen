/**
 * The in-app updater: `check()` against the release feed named in
 * tauri.conf.json (plugins.updater.endpoints), a minisign-verified download
 * and install, then a relaunch. The plugin does the verifying and the
 * platform-specific install; this module turns its results and download
 * events into the words the masthead control and the Activity log show,
 * and the pure half of that is what the tests cover.
 *
 * Two paths install (ADR-202). `installUpdate` is the person's click: it
 * installs and relaunches. `installInBackground` is the automatic install on
 * a Mac that passes the gates in update.rs: it installs and never relaunches.
 */
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import type { restartTachoService, UpdatePolicy } from "./bridge";
import type { UpdateOffer } from "./update-watch";

/** What `check()` found, minus the plugin handle. */
export type UpdateCheck =
  | { available: false; currentVersion: string }
  | { available: true; version: string; currentVersion: string; body?: string };

/** The control's caption for a completed check. */
export function describeCheck(result: UpdateCheck): string {
  return result.available
    ? `v${result.version} available`
    : `up to date (v${result.currentVersion})`;
}

/** Bytes as the size a release page would print: 79.5 MB, 812 KB, 40 B. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Running download totals; `total` is null when the feed sent no length. */
export interface DownloadProgress {
  received: number;
  total: number | null;
  /** The last milestone logged: a percent when `total` is known, else MB. */
  lastMark: number;
}

export const DOWNLOAD_START: DownloadProgress = {
  received: 0,
  total: null,
  lastMark: -1,
};

/** Percent steps between progress lines when the total is known. */
const PERCENT_STEP = 10;
/** MB between progress lines when it is not. */
const MB_STEP = 10;

/**
 * Fold one plugin download event into the running totals and say whether it
 * earned a line in the log. Progress arrives per chunk (tens of thousands of
 * events for a 80 MB bundle), so a line is emitted only at every tenth
 * percent, or every 10 MB when the size is unknown.
 */
export function applyDownloadEvent(
  progress: DownloadProgress,
  event: DownloadEvent,
): { progress: DownloadProgress; line: string | null } {
  switch (event.event) {
    case "Started": {
      const total = event.data.contentLength ?? null;
      return {
        progress: { received: 0, total, lastMark: -1 },
        line:
          total === null
            ? "Downloading…"
            : `Downloading ${formatBytes(total)}…`,
      };
    }
    case "Progress": {
      const received = progress.received + event.data.chunkLength;
      if (progress.total !== null && progress.total > 0) {
        const pct = Math.min(
          100,
          Math.floor((received / progress.total) * 100),
        );
        const mark = Math.floor(pct / PERCENT_STEP) * PERCENT_STEP;
        if (mark > progress.lastMark) {
          return {
            progress: { ...progress, received, lastMark: mark },
            line: `  ${mark}% · ${formatBytes(received)} of ${formatBytes(progress.total)}`,
          };
        }
        return { progress: { ...progress, received }, line: null };
      }
      const mb = Math.floor(received / (1024 * 1024));
      const mark = Math.floor(mb / MB_STEP) * MB_STEP;
      if (mark > progress.lastMark) {
        return {
          progress: { ...progress, received, lastMark: mark },
          line: `  ${formatBytes(received)} received`,
        };
      }
      return { progress: { ...progress, received }, line: null };
    }
    case "Finished":
      return {
        progress,
        line: `Downloaded ${formatBytes(progress.received)}; verifying the signature and installing…`,
      };
    default:
      return { progress, line: null };
  }
}

/**
 * How long a check may wait on the feed. The plugin sets no bound of its
 * own, so a feed that never answered left the check spinning for good.
 */
export const CHECK_TIMEOUT_MS = 30_000;

/**
 * Ask the feed. `null` handle means the installed build is current (or the
 * release carries no updater artifacts yet, which the feed reports the same
 * way). Network, timeout and signature errors reject; the caller shows them.
 */
export async function checkForUpdate(
  currentVersion: string,
): Promise<{ result: UpdateCheck; update: Update | null }> {
  const update = await check({ timeout: CHECK_TIMEOUT_MS });
  if (!update) {
    return { result: { available: false, currentVersion }, update: null };
  }
  return {
    result: {
      available: true,
      version: update.version,
      currentVersion: update.currentVersion || currentVersion,
      body: update.body ?? undefined,
    },
    update,
  };
}

/**
 * What runs between the install and the relaunch: the collector restart
 * (ADR-202 §4). It must not throw. The new build is on disk by then, so
 * nothing after the install may turn it into a failed update.
 */
export type AfterInstall = () => Promise<void>;

/** An `AfterInstall` that throws anyway is logged, never rethrown. */
async function runAfterInstall(
  afterInstall: AfterInstall,
  onLine: (line: string) => void,
): Promise<void> {
  try {
    await afterInstall();
  } catch (error) {
    onLine(
      `After the install: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Download, verify and install, streaming progress lines to `onLine`, then
 * run `afterInstall` and relaunch into the new build. On Windows the
 * installer quits the app itself; `relaunch()` covers macOS and Linux.
 *
 * `afterInstall` must also release the page's busy hold. A relaunch is an
 * exit request, and the Rust shell holds an exit while the page is busy, so
 * a relaunch under the hold hid the window and never reopened the app.
 *
 * A relaunch that fails is not an update that failed: the new build is on
 * disk by then. It used to reject, so the app said "Update failed" and
 * offered Install again for a version that was already installed.
 */
export async function installUpdate(
  update: Update,
  onLine: (line: string) => void,
  afterInstall: AfterInstall = async () => {},
): Promise<{ relaunched: boolean }> {
  let progress = DOWNLOAD_START;
  await update.downloadAndInstall((event) => {
    const next = applyDownloadEvent(progress, event);
    progress = next.progress;
    if (next.line !== null) onLine(next.line);
  });
  onLine(`Installed v${update.version}.`);
  await runAfterInstall(afterInstall, onLine);
  onLine("Relaunching…");
  try {
    await relaunch();
    return { relaunched: true };
  } catch (error) {
    onLine(
      `Installed v${update.version}. Quit Oxagen and open it again to use it (the relaunch did not happen: ${error instanceof Error ? error.message : String(error)}).`,
    );
    return { relaunched: false };
  }
}

/**
 * The automatic install (ADR-202 §2). The download runs with no hold on
 * quit, so a quit mid-download drops it and the next launch checks again.
 * The install runs under `hold`, so a close or a Quit during the bundle swap
 * waits for the swap to finish. `afterInstall` restarts the collector while
 * the hold still covers it.
 *
 * It never relaunches. The running app keeps the old build until the person
 * clicks Restart or opens the app again. A download, signature, or install
 * error rejects, and the caller shows the prompt for the same version.
 */
export async function installInBackground(
  update: Update,
  hold: (holding: boolean) => Promise<void>,
  afterInstall: AfterInstall,
  onLine: (line: string) => void,
): Promise<void> {
  let progress = DOWNLOAD_START;
  await update.download((event) => {
    const next = applyDownloadEvent(progress, event);
    progress = next.progress;
    if (next.line !== null) onLine(next.line);
  });
  await hold(true);
  try {
    await update.install();
    onLine(`Installed v${update.version}. Restart Oxagen to use it.`);
    await runAfterInstall(afterInstall, onLine);
  } finally {
    await hold(false);
  }
}

/** Where `routeOffer` sent an offer. */
export type OfferRoute = "installed" | "prompted" | "fell back";

/**
 * What the app does with the watch's offer (ADR-202 §1 and §3). It installs
 * in the background when `update_policy` says silent and no install is
 * running. Otherwise it prompts. An automatic install that rejects prompts
 * for the same version, so a failure never leaves the offer with no way to
 * install it. `install` logs its own error before it rejects.
 */
export async function routeOffer(
  offer: UpdateOffer,
  policy: () => Promise<UpdatePolicy | null>,
  installing: () => boolean,
  install: (offer: UpdateOffer) => Promise<void>,
  prompt: (offer: UpdateOffer) => void,
): Promise<OfferRoute> {
  const current = await policy();
  if (!current?.silent || installing()) {
    prompt(offer);
    return "prompted";
  }
  try {
    await install(offer);
    return "installed";
  } catch {
    prompt(offer);
    return "fell back";
  }
}

/** What `restartTachoService` in bridge.ts answered. */
export type ServiceRestart = Awaited<ReturnType<typeof restartTachoService>>;

/**
 * The Activity log's line for a collector restart, or null when a collector
 * that is not running, or a platform with none to restart, leaves nothing
 * to say.
 */
export function describeRestart(result: ServiceRestart): string | null {
  if (!result.ok) {
    return `The collector did not restart, so it runs the old build until you sign out or run tacho enroll: ${result.error}`;
  }
  return result.outcome === "restarted"
    ? "Restarted the collector on the new build."
    : null;
}

/** Relaunch into the build on disk: the masthead's Restart button. */
export const restartApp = () => relaunch();
