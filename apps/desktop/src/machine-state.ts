/**
 * What the app concludes about the machine from the files it reads. Pure, so
 * each conclusion is a test and not something a panel works out inline.
 */

/**
 * Enrolled means the hooks and the service are on the machine. A `host.json`
 * with `revoked_at` set is one `tacho unenroll` already retired: the hooks and
 * the service are gone, and the file is kept only so a revoke that could not
 * reach the control plane can be finished. Reading that file's existence as
 * "enrolled" kept the app on its manage screens for a machine that was not,
 * and made Uninstall fail the same way on every retry.
 */
export function isEnrolled(
  host: { revoked_at?: string | null } | null | undefined,
): boolean {
  return host != null && (host.revoked_at ?? null) === null;
}

/** Unenrolled here, with the server-side revoke still to finish. */
export function isRetired(
  host: { revoked_at?: string | null } | null | undefined,
): boolean {
  return host != null && typeof host.revoked_at === "string";
}

/** What the Rust shell's `remove_local_data` reports. */
export interface RemovalReport {
  removed: string[];
  /** Still on the machine, each with why. */
  left: string[];
}

/** The notice after an uninstall: what happened, never "everything is gone" on faith. */
export function describeRemoval(report: RemovalReport, hint: string): string {
  if (report.removed.length === 0 && report.left.length === 0)
    return `Nothing of Oxagen's was left on this machine. ${hint}`;
  const count = report.removed.length;
  const removed = `Removed ${count} item${count === 1 ? "" : "s"} from this machine.`;
  if (report.left.length === 0) return `${removed} ${hint}`;
  return `${removed} Still on this machine: ${report.left.join(". ")}. ${hint}`;
}

/** What the Rust shell's `install_cli` reports. */
export interface InstallResult {
  /** "linked", "already" or "skipped". */
  state: string;
  dir: string;
  files: string[];
  skipped: string[];
  on_path: boolean;
  note: string;
  profile: string | null;
}

/**
 * The notice after "Link into PATH". It used to read "0 links in ~/.local/bin"
 * both when the two tools were already linked and when neither was linked
 * because a Homebrew `oxagen` wins on PATH.
 */
export function describeInstallResult(result: InstallResult): string {
  if (
    result.state === "skipped" ||
    (result.files.length === 0 && result.skipped.length > 0)
  )
    return `Nothing was linked. ${result.skipped.join(". ")}.`;
  if (result.files.length === 0) return result.note;
  const count = result.files.length;
  return `Linked ${count} tool${count === 1 ? "" : "s"} into ${result.dir}. ${result.note}`;
}

/**
 * Whether the binaries the hooks and the service run have fallen behind the
 * app, as one sentence, or null when they have not. Two ways it happens: an
 * in-app update replaces the sidecar while the collector keeps running the
 * old one, and an app moved out of a disk image leaves the hooks naming the
 * older durable copy. `tacho enroll` with no flags re-applies both.
 */
export function binSkew(
  host: { wrapper_version: string; hook_command: string },
  state: { app_version: string; bin_dir: string | null },
): string | null {
  if (state.bin_dir === null) return null;
  // A tacho from somewhere else (Homebrew, a checkout) enrolled this machine.
  const ours =
    /oxagen/i.test(host.hook_command) ||
    host.hook_command.includes(state.bin_dir);
  if (!ours) return null;
  if (!host.hook_command.includes(state.bin_dir)) {
    const named = /^'([^']+)'|^"([^"]+)"|^(\S+)/.exec(host.hook_command);
    const path = named?.[1] ?? named?.[2] ?? named?.[3] ?? host.hook_command;
    return `The hooks run ${path}, not the tools in this app (${state.bin_dir}). Re-apply to point them here.`;
  }
  if (host.wrapper_version !== state.app_version)
    return `The collector was set up by version ${host.wrapper_version} and this app is ${state.app_version}. Re-apply to restart it on this version.`;
  return null;
}

export interface Poller {
  /**
   * Read and apply. A call that lands while a read is out joins it instead
   * of starting another. `force` starts a fresh read at once (after an
   * action changed the machine), and an older read that finishes later is
   * dropped instead of overwriting the newer answer.
   */
  poll: (options?: { force?: boolean }) => Promise<void>;
  /**
   * Drop whatever read is out, and let the next poll start a fresh one. An
   * action calls this before it changes the machine: a 20 s `tacho status`
   * started before `reassign` would otherwise land after it and put the old
   * machine back on screen.
   */
  invalidate: () => void;
}

/**
 * The state poll. `setInterval` fired every five seconds whether or not the
 * last read had finished, one read can block 1.5 s on the collector and
 * `tacho status` up to 20 s, and results were applied in arrival order, so a
 * slow old answer could replace a newer one.
 */
export function createPoller<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  onError: (error: unknown) => void = () => undefined,
): Poller {
  let latest = 0;
  let inFlight: Promise<void> | null = null;
  const run = (): Promise<void> => {
    latest += 1;
    const mine = latest;
    const done = read()
      .then(
        (value) => {
          if (mine === latest) apply(value);
        },
        (error: unknown) => {
          if (mine === latest) onError(error);
        },
      )
      .finally(() => {
        if (inFlight === done) inFlight = null;
      });
    inFlight = done;
    return done;
  };
  return {
    poll: (options) =>
      options?.force !== true && inFlight !== null ? inFlight : run(),
    invalidate: () => {
      latest += 1;
      inFlight = null;
    },
  };
}

/**
 * The error banner after a `tacho status` read. A failure is shown once and
 * not raised again while it repeats. A read that works clears the banner only
 * when the banner still shows that failure: it used to leave a recovered
 * failure on screen, and clearing whatever was shown would have hidden an
 * action's own error.
 */
export function statusBanner(
  banner: string | null,
  lastStatusError: string | null,
  outcome: { ok: true } | { ok: false; error: string },
): string | null {
  if (outcome.ok)
    return lastStatusError !== null && banner === lastStatusError
      ? null
      : banner;
  return outcome.error === lastStatusError ? banner : outcome.error;
}
