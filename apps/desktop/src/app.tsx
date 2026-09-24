/**
 * The Oxagen app, one pane on paper.
 *
 * First run (no enrollment on this machine): a five-step wizard — sign in,
 * pick the org and workspace the operator can see, register the agents the
 * machine has (Claude Code, Codex, Cursor; detected, all ticked by default), the
 * outcome, then a recorded first run and the door to the workspace in Oxagen.
 *
 * Every later run (the machine is enrolled): the management pane — what the
 * host reports to, one de-register per wrapped agent, change of workspace,
 * a first-run button per agent, and the uninstall that takes everything
 * Oxagen put on the machine away. Both destructive paths confirm twice, as
 * the install side did.
 *
 * The app owns no state: it reads what the CLIs wrote and runs a sidecar
 * for every change (see bridge.ts); the argv it builds is in commands.ts.
 */
import {
  binSkew,
  createPoller,
  describeInstallResult,
  describeRemoval,
  isEnrolled,
  isRetired,
  statusBanner,
  TOAST_MS,
  uninstallFinished,
  uninstallToast,
} from "./machine-state";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { gatewayText, serviceStatusText } from "./tacho-status";
import { computeAgentRows, HEALTH_LABEL, summarizeAgents } from "./agents";
import {
  checkLiveSession,
  sidecarEnv,
  type ConnectResult,
  connectRun,
  type DesktopState,
  type DetectReport,
  detectHarnesses,
  installCli,
  isUnauthorized,
  listOrganizations,
  listWorkspaces,
  logTail,
  type OrgItem,
  readState,
  removeLocalData,
  runSidecar,
  type TachoStatus,
  tachoStatus,
  uninstallCli,
  type WorkspaceItem,
} from "./bridge";
import {
  ago,
  collectorText,
  defaultRegistration,
  deregisterArgs,
  deregisterNeedsSession,
  describeCliInstall,
  enrollArgs,
  HARNESS_LABEL,
  HARNESSES,
  type Harness,
  loginArgs,
  needsWorkspacePick,
  pendingChange,
  reassignArgs,
  isConnected,
  type SessionView,
  sessionLanded,
  unenrollArgs,
  verifiable,
  wizardStep,
  workspaceUrl,
} from "./commands";
import { checkForUpdate, describeCheck, installUpdate } from "./updater";

const WRAP_AGENT_URL = "https://docs.oxagen.sh/docs/cli/wrap-an-agent";
const DESKTOP_GUIDE_URL = "https://docs.oxagen.sh/docs/cli/desktop";

/**
 * Claude Code and Codex are npm packages; Stella and Cursor install from a
 * script. Cursor's is verified 2026-09-18 against
 * https://cursor.com/docs/cli/installation (fetched that day).
 */
const INSTALL_HINT: Record<Harness, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
  cursor: "curl https://cursor.com/install -fsS | bash",
  stella:
    "curl -fsSL https://raw.githubusercontent.com/macanderson/stella/main/install.sh | sh",
  // A connected app is downloaded, not installed from a terminal. Sending a
  // non-developer to a command line is the thing this release exists to stop.
  "claude-desktop": "https://claude.ai/download",
};

interface LogLine {
  text: string;
  err: boolean;
}

interface RunOutcome {
  code: number | null;
  stderr: string;
}

/**
 * One state read. `status` is what `tacho status` said, and is absent when it
 * was not asked this time (a plain tick, or an action running): the panel
 * keeps what it shows.
 */
interface MachineRead {
  next: DesktopState;
  status?:
    | { ok: true; value: TachoStatus | null }
    | { ok: false; error: string };
}

const labelOf = (h: string) => HARNESS_LABEL[h as Harness] ?? h;
const joinLabels = (list: readonly string[]) => list.map(labelOf).join(" and ");

/** Open a docs URL in the system browser instead of navigating the webview. */
const openDocs = (url: string) => (e: MouseEvent) => {
  e.preventDefault();
  void openUrl(url);
};

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [tacho, setTacho] = useState<TachoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set once an uninstall has left nothing behind: the Uninstall panel has
  // nothing more to offer and goes away until the machine is set up again.
  const [uninstalled, setUninstalled] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Bumped after every sign-in so the org listing runs again: config.json's
  // `logged_in` is presence-only and stays true across an expired session
  // being replaced, so the boolean alone never re-triggers the listing.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [orgs, setOrgs] = useState<OrgItem[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[] | null>(null);
  // Which listing failed for a reason other than a dead session (no network,
  // a 5xx). Retry bumps `listingEpoch`, which runs both listings again: an
  // empty list with no way to ask again left the first run stuck on step 2.
  const [listingFailed, setListingFailed] = useState({
    orgs: false,
    workspaces: false,
  });
  const [listingEpoch, setListingEpoch] = useState(0);
  const [pickedOrg, setPickedOrg] = useState<string | null>(null);
  const [pickedWorkspace, setPickedWorkspace] = useState<string | null>(null);
  const [tail, setTail] = useState<string>("");
  const [update, setUpdate] = useState<{
    caption: string | null;
    offered: Update | null;
  }>({ caption: null, offered: null });
  // An update check reads the release feed and changes nothing on the
  // machine, so it has its own flag rather than `busy`: holding `busy` froze
  // every control for as long as the feed took to answer.
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<number | null>(null);
  // The last `tacho status` failure shown, so a failure that repeats on
  // every poll is reported once rather than re-raised every 20 s.
  const statusErrorRef = useRef<string | null>(null);

  // Wizard-only state. `firstRun` is fixed at launch: an enrolled machine
  // never sees the wizard, a fresh one stays in it until Finish.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  const [targetChosen, setTargetChosen] = useState(false);
  const [detected, setDetected] = useState<DetectReport | null>(null);
  const [detecting, setDetecting] = useState(false);
  // Why the last scan failed. Kept apart from `detected`: a failed scan read
  // as an empty report said none of the agents was installed.
  const [scanError, setScanError] = useState<string | null>(null);
  const [registration, setRegistration] = useState<Harness[] | null>(null);
  const [outcome, setOutcome] = useState<{
    ok: boolean;
    detail: string;
  } | null>(null);
  const [outcomeSeen, setOutcomeSeen] = useState(false);
  const [runPicks, setRunPicks] = useState<Harness[] | null>(null);
  const [runs, setRuns] = useState<Partial<Record<Harness, ConnectResult>>>({});
  const [ranOnce, setRanOnce] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [alsoDefault, setAlsoDefault] = useState(true);

  // True while an action is changing the machine. The poll skips `tacho
  // status` then: it would read the same files `enroll` or `unenroll` is
  // rewriting, and its transient failure replaced the action's own error.
  const busyRef = useRef(false);
  // Set by a tick that wants `tacho status`, cleared by the read that asks
  // it. A tick that joins a plain read already out leaves it set, so the
  // next read asks instead of the hooks going unread for another 20 s.
  const hooksDueRef = useRef(false);
  // One poller for both kinds of read, and every result applied in `apply`,
  // so a slow old answer never replaces a newer one: see `createPoller`. Two
  // pollers that each set state inside their read let a 20 s `tacho status`
  // started before an action land after it.
  const poller = useMemo(
    () =>
      createPoller<MachineRead>(
        async () => {
          const withHooks = hooksDueRef.current;
          hooksDueRef.current = false;
          const next = await readState();
          if (!isEnrolled(next.host))
            return { next, status: { ok: true, value: null } };
          if (!withHooks || busyRef.current) return { next };
          try {
            return { next, status: { ok: true, value: await tachoStatus() } };
          } catch (e) {
            // Hook presence, service state and WAL figures are now unknown;
            // `apply` says so once and the rest of the panel reads the files.
            return {
              next,
              status: {
                ok: false,
                error: `tacho status failed: ${e instanceof Error ? e.message : String(e)}`,
              },
            };
          }
        },
        ({ next, status }) => {
          setState(next);
          setFirstRun((prev) =>
            prev === null ? !isEnrolled(next.host) : prev,
          );
          if (status === undefined) return;
          setTacho(status.ok ? status.value : null);
          // Not enrolled: there was no status to ask for, so nothing about
          // the banner changed.
          if (status.ok && !isEnrolled(next.host)) return;
          const last = statusErrorRef.current;
          const outcome = status.ok
            ? { ok: true as const }
            : { ok: false as const, error: status.error };
          statusErrorRef.current = status.ok ? null : status.error;
          setError((banner) => statusBanner(banner, last, outcome));
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [],
  );
  const refresh = useCallback(
    (withHooks = false, force = true) => {
      if (withHooks) hooksDueRef.current = true;
      return poller.poll({ force });
    },
    [poller],
  );

  useEffect(() => {
    void refresh(true);
    let tick = 0;
    pollRef.current = window.setInterval(() => {
      tick += 1;
      // A tick joins a read that is still out instead of stacking another.
      void refresh(tick % 4 === 0, false);
    }, 5000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  // `host` is an enrolled host or null. A host.json that `tacho unenroll`
  // retired (an offline revoke) is `retiredHost`: not enrolled, not wrapped,
  // and not a reason to refuse an uninstall. See `isEnrolled`.
  const rawHost = state?.host ?? null;
  const host = isEnrolled(rawHost) ? rawHost : null;
  // A machine enrolled again, from here or from a terminal, has something to
  // uninstall again.
  useEffect(() => {
    if (host !== null) setUninstalled(false);
  }, [host]);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const retiredHost = isRetired(rawHost) ? rawHost : null;
  const hostHarnesses = (host?.harnesses ?? []) as Harness[];
  const configToken = state?.config.logged_in ?? false;
  const loggedIn = configToken && !sessionExpired;
  const daemonUp = state?.daemon != null;
  // The org and workspace the pickers show: the pick, else what the host
  // reports to, else the CLI default. Once another org is picked, the
  // workspace is only what was picked in it — the previous org's slug is not
  // a workspace there.
  const currentOrg = host?.org_slug ?? state?.config.org_slug ?? null;
  const orgForPicker = pickedOrg ?? currentOrg;
  const workspacePending = needsWorkspacePick(currentOrg, {
    org: pickedOrg,
    workspace: pickedWorkspace,
  });
  const workspaceTarget = workspacePending
    ? null
    : (pickedWorkspace ??
      host?.workspace_slug ??
      state?.config.workspace_slug ??
      null);

  // A token in config.json is "signed in" until the control plane says
  // otherwise; a 401 from the first user-scoped call marks the session dead.
  useEffect(() => {
    if (!configToken) {
      setOrgs(null);
      setWorkspaces(null);
      setSessionExpired(false);
      setListingFailed((prev) => ({ ...prev, orgs: false }));
      return;
    }
    let cancelled = false;
    listOrganizations()
      .then((list) => {
        if (!cancelled) {
          setOrgs(list);
          setSessionExpired(false);
          setListingFailed((prev) => ({ ...prev, orgs: false }));
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setOrgs([]);
        // A dead session is fixed by signing in, not by asking again.
        const expired = isUnauthorized(e);
        setListingFailed((prev) => ({ ...prev, orgs: !expired }));
        if (expired) setSessionExpired(true);
        else
          setError(
            `Could not list organizations: ${e instanceof Error ? e.message : String(e)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [configToken, sessionEpoch, listingEpoch]);
  useEffect(() => {
    if (!loggedIn || !orgForPicker) {
      setWorkspaces(null);
      setListingFailed((prev) => ({ ...prev, workspaces: false }));
      return;
    }
    let cancelled = false;
    listWorkspaces(orgForPicker)
      .then((list) => {
        if (!cancelled) {
          setWorkspaces(list);
          setListingFailed((prev) => ({ ...prev, workspaces: false }));
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setWorkspaces([]);
        const expired = isUnauthorized(e);
        setListingFailed((prev) => ({ ...prev, workspaces: !expired }));
        if (expired) setSessionExpired(true);
        else
          setError(
            `Could not list workspaces of ${orgForPicker}: ${e instanceof Error ? e.message : String(e)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [loggedIn, orgForPicker, listingEpoch]);
  const listingRetry = listingFailed.orgs || listingFailed.workspaces;
  const retryListing = () => {
    setError((prev) => (prev?.startsWith("Could not list ") ? null : prev));
    setListingEpoch((n) => n + 1);
  };

  const step = wizardStep({
    loggedIn,
    targetChosen,
    enrolled: host !== null,
    outcomeSeen,
  });

  // Step 3 opens with a scan of the machine. One scan at a time, tracked in
  // a ref: putting `detecting` in the dependency list made setDetecting(true)
  // re-run the effect, whose cleanup then discarded the result and left the
  // step on "Scanning…" for good. The scan's own timeout (tacho's exec
  // budget) bounds it; a result is always applied.
  const scanRef = useRef(false);
  useEffect(() => {
    if (firstRun !== true || step !== 3 || detected !== null) return;
    // A failed scan waits for Rescan rather than retrying on its own.
    if (scanError !== null || scanRef.current) return;
    scanRef.current = true;
    setDetecting(true);
    detectHarnesses()
      .then((report) => {
        setDetected(report);
        setRegistration(defaultRegistration(report.harnesses));
      })
      .catch((e: unknown) => {
        const text = e instanceof Error ? e.message : String(e);
        setScanError(text);
        setRegistration(null);
        setError(`Could not scan for agents: ${text}`);
      })
      .finally(() => {
        scanRef.current = false;
        setDetecting(false);
      });
  }, [firstRun, step, detected, scanError]);
  const rescan = () => {
    setError((prev) =>
      prev?.startsWith("Could not scan for agents") ? null : prev,
    );
    setDetected(null);
    setScanError(null);
  };

  /**
   * Poll `landed` until it answers true. Used to stop waiting on a sidecar
   * that has already written its result to disk; see `sessionLanded`.
   *
   * `poll.stopped` is how the caller ends it. A `Promise.race` does not
   * cancel its loser, and this one would otherwise outlive the action that
   * started it: a login that fails, or one whose session fields never change,
   * would leave it calling `readState` every 500ms for the rest of the app
   * session, and on an enrolled machine each of those waits on the daemon.
   */
  async function waitForLanding(
    landed: () => Promise<boolean>,
    poll: { stopped: boolean },
  ): Promise<RunOutcome> {
    while (!poll.stopped) {
      await new Promise((r) => setTimeout(r, 500));
      if (poll.stopped) break;
      if (await landed().catch(() => false)) return { code: 0, stderr: "" };
    }
    // The race settled without this one; the value is never read.
    return { code: null, stderr: "" };
  }

  async function act(
    name: string,
    sidecar: "tacho" | "oxagen",
    args: string[],
    after?: (result: RunOutcome) => Promise<void> | void,
    onFail?: (result: RunOutcome) => void,
    /**
     * An alternative finish line: when it answers true the action is done,
     * whether or not the process has exited. The sidecar keeps streaming into
     * the output panel either way.
     */
    landed?: () => Promise<boolean>,
  ) {
    // A second click that lands before React has disabled the button must
    // not start a second `unenroll` or `reassign` beside the first.
    if (busyRef.current) return;
    busyRef.current = true;
    // A read already out describes the machine before this action; it must
    // not land after it.
    poller.invalidate();
    setBusy(name);
    setError(null);
    setNotice(null);
    setConfirming(null);
    setLog([{ text: `$ ${sidecar} ${args.join(" ")}`, err: false }]);
    try {
      const env = await sidecarEnv();
      const run = runSidecar(
        sidecar,
        args,
        (line, stream) =>
          setLog((prev) => [...prev, { text: line, err: stream === "stderr" }]),
        { env },
      );
      let result: RunOutcome;
      if (landed) {
        const poll = { stopped: false };
        try {
          result = await Promise.race([run, waitForLanding(landed, poll)]);
        } finally {
          // Whichever won, the other one is done being useful.
          poll.stopped = true;
        }
        // The race leaves the sidecar running when `landed` wins. Its failure
        // is still a failure of this action if it comes before the next one.
        run.catch((e: unknown) =>
          setError(e instanceof Error ? e.message : String(e)),
        );
      } else {
        result = await run;
      }
      if (result.code !== 0) {
        setError(
          `${sidecar} ${args[0]} exited ${result.code ?? "?"}; see the output below.`,
        );
        onFail?.(result);
      } else {
        await after?.(result);
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setError(text);
      onFail?.({ code: null, stderr: text });
    } finally {
      busyRef.current = false;
      setBusy(null);
      await refresh(true);
    }
  }

  // A destructive control confirms in place, and the confirm button takes
  // the slot the first button had. The second click of a double click landed
  // on it. A confirm is ignored for a moment after it appears.
  const confirmShownAt = useRef(0);
  const askConfirm = (key: string) => {
    confirmShownAt.current = Date.now();
    setConfirming(key);
  };
  const confirmed = (run: () => unknown) => () => {
    if (Date.now() - confirmShownAt.current < 500) return;
    void run();
  };

  // `oxagen login --browser` replaces whatever session config.json holds,
  // so a sign-in after a 401 (or a Switch organization) starts the pickers
  // over from the new session rather than keeping the dead one's verdict.
  const signIn = (options: { signup?: boolean } = {}) => {
    const before: SessionView = {
      logged_in: configToken,
      org_slug: state?.config.org_slug ?? null,
      workspace_slug: state?.config.workspace_slug ?? null,
    };
    return act(
      options.signup ? "signup" : "signin",
      "oxagen",
      loginArgs(options),
      () => {
        setSessionExpired(false);
        setSessionEpoch((n) => n + 1);
        setPickedOrg(null);
        setPickedWorkspace(null);
        setNotice(
          options.signup ? "Account created and signed in." : "Signed in.",
        );
      },
      undefined,
      async () => {
        const { config } = await readState();
        return sessionLanded(before, {
          logged_in: config.logged_in,
          org_slug: config.org_slug,
          workspace_slug: config.workspace_slug,
        });
      },
    );
  };
  const signOut = () =>
    act("signout", "oxagen", ["logout"], () => {
      setOrgs(null);
      setWorkspaces(null);
      setPickedOrg(null);
      setPickedWorkspace(null);
      setTargetChosen(false);
    });

  const register = () => {
    const chosen = registration ?? [];
    setOutcome(null);
    let args: string[];
    try {
      args = enrollArgs({
        org: orgForPicker,
        workspace: workspaceTarget,
        harnesses: chosen,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    return act(
      "enroll",
      "tacho",
      args,
      () => {
        setOutcome({
          ok: true,
          detail: `Registered ${joinLabels(chosen)} with Oxagen.`,
        });
        // Only the wrapped ones: `tacho verify` cannot drive a connected app.
        setRunPicks(verifiable(chosen));
      },
      (result) => {
        const lines = result.stderr.trim().split("\n").filter(Boolean);
        setOutcome({
          ok: false,
          detail:
            lines.at(-1) ??
            `tacho enroll exited ${result.code ?? "?"} without a message`,
        });
      },
    );
  };

  async function runConnect(only?: Harness[]) {
    // `verifiable` again at the call site, not only where runPicks is set: a
    // connected app must never reach `tacho verify`, whichever path asked.
    const picks = verifiable(only ?? runPicks ?? hostHarnesses);
    if (picks.length === 0) return;
    setBusy("connect");
    setError(null);
    setNotice(null);
    setConfirming(null);
    setLog([]);
    setRanOnce(true);
    const results: Partial<Record<Harness, ConnectResult>> = { ...runs };
    for (const h of picks) {
      setLog((prev) => [
        ...prev,
        { text: `$ tacho verify --harness ${h}`, err: false },
      ]);
      try {
        results[h] = await connectRun(h, (line, stream) =>
          setLog((prev) => [...prev, { text: line, err: stream === "stderr" }]),
        );
      } catch (e) {
        results[h] = {
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
      setRuns({ ...results });
    }
    setBusy(null);
    await refresh(true);
  }

  const openWorkspace = () => {
    if (!state || !host) return;
    void openUrl(
      workspaceUrl(state.config.app_url, host.org_slug, host.workspace_slug),
    );
  };

  /**
   * Ask the control plane whether the session still works, right before an
   * action that runs `tacho reassign`: with a dead token, reassign revokes
   * the enrollment, strips the hooks, fails to enroll again and removes the
   * service. `sessionExpired` is learned from the picker's first call only,
   * so a session that died since still reads as signed in. The check holds
   * the action's busy state, so a second click cannot start another beside
   * it; on true the caller hands straight to `act`.
   */
  async function requireLiveSession(name: string): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(name);
    setError(null);
    setNotice(null);
    setConfirming(null);
    const check = await checkLiveSession();
    busyRef.current = false;
    if (check.live) return true;
    if (check.expired) setSessionExpired(true);
    setError(check.message);
    setBusy(null);
    return false;
  }

  const applyWorkspace = async () => {
    if (!host) return;
    let call: ReturnType<typeof reassignArgs>;
    try {
      call = reassignArgs(
        host,
        { org: pickedOrg, workspace: pickedWorkspace, harnesses: null },
        alsoDefault,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!(await requireLiveSession("apply"))) return;
    return act("apply", call.sidecar, call.args, () => {
      setPickedOrg(null);
      setPickedWorkspace(null);
      setNotice("Reassigned; the device key was kept.");
    });
  };

  const deregister = async (h: Harness) => {
    if (!host) return;
    const call = deregisterArgs(host.harnesses, h);
    if (
      deregisterNeedsSession(host.harnesses, h) &&
      !(await requireLiveSession("deregister"))
    )
      return;
    return act("deregister", call.sidecar, call.args, () =>
      setNotice(
        call.args[0] === "unenroll"
          ? `${labelOf(h)} was the last wrapped agent: hooks, service and credentials removed.`
          : `${labelOf(h)} de-registered; its hooks are removed.`,
      ),
    );
  };

  const addHarness = async (h: Harness) => {
    if (!host) return;
    const harnesses = [...host.harnesses, h];
    if (!(await requireLiveSession("add"))) return;
    return act(
      "add",
      "tacho",
      ["reassign", "--harness", harnesses.join(",")],
      () => setNotice(`${labelOf(h)} is now wrapped.`),
    );
  };

  async function uninstallEverything() {
    if (busyRef.current) return;
    busyRef.current = true;
    poller.invalidate();
    setConfirming(null);
    setBusy("uninstall");
    setError(null);
    setNotice(null);
    setLog([{ text: "$ tacho unenroll --purge", err: false }]);
    try {
      // Always, enrolled or not: `unenroll` strips Tacho's hooks and the
      // service whether or not host.json is there, and finishes a revoke an
      // earlier offline run left pending.
      const result = await runSidecar("tacho", unenrollArgs(true), (line, s) =>
        setLog((prev) => [...prev, { text: line, err: s === "stderr" }]),
      );
      if (result.code !== 0)
        throw new Error(
          `tacho unenroll could not finish (exit ${result.code ?? "?"}). Nothing else was removed. The output below says what is still in place.`,
        );
      const report = await removeLocalData();
      setLog((prev) => [
        ...prev,
        ...report.removed.map((path) => ({
          text: `removed ${path}`,
          err: false,
        })),
        ...report.left.map((note) => ({ text: `left: ${note}`, err: true })),
      ]);
      setNotice(describeRemoval(report, uninstallHint));
      if (uninstallFinished(report)) {
        setUninstalled(true);
        setToast(uninstallToast(uninstallHint));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(null);
      await refresh(true);
    }
  }

  async function doInstallCli() {
    setBusy("cli");
    setError(null);
    try {
      setNotice(describeInstallResult(await installCli()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  }
  async function doRemoveCliLinks() {
    setBusy("cli-remove");
    setError(null);
    try {
      const removed = await uninstallCli();
      setNotice(
        removed.length > 0
          ? `Removed PATH links: ${removed.join(", ")}.`
          : "No PATH links to remove.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  }
  async function showLog() {
    try {
      setTail(await logTail(120));
    } catch (e) {
      setError(
        `Could not read the collector log: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  /**
   * Open the collector log in the system handler. `open_path` is scoped to
   * `~/.config/oxagen` in capabilities/default.json; a log elsewhere (a
   * `TACHO_HOME` override) falls back to revealing it in the file manager,
   * which the opener permits for any path.
   */
  async function openLog(path: string) {
    try {
      await openPath(path);
    } catch (first) {
      try {
        await revealItemInDir(path);
      } catch (second) {
        setError(
          `Could not open ${path}: ${second instanceof Error ? second.message : String(second)} (${first instanceof Error ? first.message : String(first)})`,
        );
      }
    }
  }

  async function doCheckUpdate() {
    if (!state || checking) return;
    setChecking(true);
    setUpdate({ caption: "checking…", offered: null });
    try {
      const r = await checkForUpdate(state.app_version);
      setUpdate({ caption: describeCheck(r.result), offered: r.update });
    } catch (e) {
      setUpdate({ caption: null, offered: null });
      setError(
        `Update check failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setChecking(false);
    }
  }
  async function doInstallUpdate() {
    const offered = update.offered;
    if (!offered) return;
    setBusy("update");
    setError(null);
    setNotice(null);
    setUpdate({ caption: `installing v${offered.version}…`, offered });
    setLog([{ text: `$ update to v${offered.version}`, err: false }]);
    try {
      const { relaunched } = await installUpdate(offered, (line) =>
        setLog((prev) => [...prev, { text: line, err: false }]),
      );
      if (!relaunched) {
        setUpdate({
          caption: `v${offered.version} installed; quit and reopen Oxagen`,
          offered: null,
        });
        setNotice(
          `Version ${offered.version} is installed. Quit Oxagen and open it again to use it.`,
        );
        setBusy(null);
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setLog((prev) => [...prev, { text, err: true }]);
      setError(`Update failed: ${text}`);
      setUpdate({
        caption: describeCheck({
          available: true,
          version: offered.version,
          currentVersion: offered.currentVersion,
        }),
        offered,
      });
      setBusy(null);
    }
  }

  const restartWizard = () => {
    setUninstalled(false);
    setFirstRun(true);
    setTargetChosen(false);
    setDetected(null);
    setScanError(null);
    setRegistration(null);
    setOutcome(null);
    setOutcomeSeen(false);
    setRunPicks(null);
    setRuns({});
    setRanOnce(false);
  };

  const uninstallHint =
    state?.platform === "macos"
      ? "Drag Oxagen from Applications to the Trash to finish."
      : state?.platform === "windows"
        ? "Remove Oxagen from Settings › Apps to finish."
        : "Remove the package (apt/dnf) or delete the AppImage to finish.";
  // Running from a directory that is gone after this launch (an AppImage
  // mount, a mounted .dmg, App Translocation) with no durable copy of the
  // tools yet: hooks and the service written now would stop working when
  // the app quits, so tacho refuses; "Keep the tools" makes the copy.
  const toolsTransient =
    state?.sidecar_transient === true && state.bin_dir === null;
  const keepToolsHint =
    state?.platform === "macos"
      ? "Oxagen is running from the disk image (or where it was downloaded). Move it to Applications and open it again, or keep a copy of the tools."
      : "Oxagen is running from the AppImage mount. Install the .deb or .rpm, or keep a copy of the tools.";
  const dotClass = !host
    ? ""
    : daemonUp && host.host_status === "active"
      ? "on"
      : "half";
  const agentRows = state
    ? computeAgentRows({ ...state, host }, tacho, Date.now())
    : [];
  const skewNote = host && state ? binSkew(host, state) : null;
  const cliInstallNote = describeCliInstall(state?.cli_install);
  // Whether there is anything for "Remove links" to remove. The two
  // `*_on_path` fields answer a different question: they resolve against the
  // running process's PATH, and a GUI launch never sources a login profile,
  // so they stay null on macOS and Linux even in the moment after the app
  // linked both tools. Only fall back to them on a build whose Rust shell
  // does not report `cli_links_present` yet.
  const cliLinksPresent =
    state === null
      ? false
      : (state.cli_links_present ??
        (state.oxagen_on_path !== null || state.tacho_on_path !== null));

  // A running sidecar locks the pickers, with one exception: the sign-in that
  // fills them. Picking changes local state only, but `applyWorkspace` reads
  // that state when it starts and clears it when it succeeds, so a change made
  // while `tacho reassign` runs would move the machine to the old target and
  // drop the new choice without saying so.
  const pickersLocked = busy !== null && busy !== "signin" && busy !== "signup";

  const orgPicker = (
    <select
      aria-label="Organization"
      id="org"
      value={orgForPicker ?? ""}
      onChange={(e) => {
        setPickedOrg(e.target.value);
        setPickedWorkspace(null);
      }}
      disabled={pickersLocked || orgs === null}
    >
      {(orgs ?? []).map((o) => (
        <option key={o.slug} value={o.slug}>
          {o.name} ({o.slug})
        </option>
      ))}
      {orgForPicker && !(orgs ?? []).some((o) => o.slug === orgForPicker) && (
        <option value={orgForPicker}>{orgForPicker}</option>
      )}
    </select>
  );
  const workspacePicker = (
    <select
      aria-label="Workspace"
      id="workspace"
      value={workspaceTarget ?? ""}
      onChange={(e) => setPickedWorkspace(e.target.value)}
      disabled={pickersLocked || workspaces === null}
    >
      {workspaceTarget === null && <option value="">Pick a workspace…</option>}
      {(workspaces ?? []).map((w) => (
        <option key={w.slug} value={w.slug}>
          {w.name} ({w.slug})
        </option>
      ))}
      {workspaceTarget &&
        !(workspaces ?? []).some((w) => w.slug === workspaceTarget) && (
          <option value={workspaceTarget}>{workspaceTarget}</option>
        )}
    </select>
  );

  const activity = (
    <section className="panel" aria-labelledby="out">
      <p className="eyebrow" id="out">
        Activity
      </p>
      {log.length === 0 ? (
        <p className="sub">Output of the last action appears here.</p>
      ) : (
        <pre className="log mono" aria-live="polite">
          {log.map((l, i) => (
            <span key={i} className={l.err ? "err" : ""}>
              {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      <details onToggle={(e) => e.currentTarget.open && void showLog()}>
        <summary>Collector log</summary>
        <pre className="log mono">{tail || "(empty)"}</pre>
        <div className="row">
          <button
            type="button"
            className="quiet"
            // The collector writes this file on its first run. Before that
            // there is nothing to open, and handing the path to the system
            // opener answers with a launcher error about a missing file
            // rather than with the honest reason.
            disabled={state?.log_present !== true}
            title={
              state?.log_present === true
                ? undefined
                : "The collector has not written a log on this machine yet."
            }
            onClick={() => state && void openLog(state.log_path)}
          >
            Open {state?.log_path}
          </button>
        </div>
      </details>
    </section>
  );

  const stepClass = (n: number) =>
    `step ${step === n ? "active" : step > n ? "done" : "todo"}`;
  const stepMark = (n: number) => (step > n ? "✓" : String(n));
  const runList = verifiable(runPicks ?? hostHarnesses);

  // ── First run: the wizard ────────────────────────────────────────────────
  const wizard = (
    <>
      <div>
        <p className="eyebrow">Set up this machine</p>
        <h1 className="headline">Put your agents under Oxagen control</h1>
        <p className="sub">
          Five steps, a few minutes. Nothing here needs the terminal.
        </p>
      </div>
      <ol className="steps">
        <li className={stepClass(1)}>
          <span className="n">{stepMark(1)}</span>
          <div>
            <p className="headline">Authenticate with Oxagen</p>
            {step === 1 ? (
              <>
                <p className="sub">
                  {sessionExpired
                    ? `The saved session for ${state?.config.org_slug ?? "your organization"} has expired. `
                    : ""}
                  Sign in opens your browser; come back here when it says you
                  are done. New to Oxagen? Create an account — you will name
                  your organization and first workspace, then land back here.
                </p>
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => signIn()}
                    disabled={busy !== null}
                  >
                    {busy === "signin" ? "Waiting for the browser…" : "Sign in"}
                  </button>
                  <button
                    type="button"
                    onClick={() => signIn({ signup: true })}
                    disabled={busy !== null}
                  >
                    {busy === "signup"
                      ? "Waiting for the browser…"
                      : "Create an account"}
                  </button>
                </div>
              </>
            ) : (
              <p className="sub">Signed in · {state?.config.api_url}</p>
            )}
          </div>
        </li>

        <li className={stepClass(2)}>
          <span className="n">{stepMark(2)}</span>
          <div>
            <p className="headline">Select an organization and workspace</p>
            {step === 2 ? (
              <>
                <p className="sub">
                  Only the organizations and workspaces you belong to are
                  listed. This is where the machine's sessions are recorded.
                </p>
                <div className="row">
                  {orgPicker}
                  {workspacePicker}
                  {listingRetry && (
                    <button
                      type="button"
                      className="quiet"
                      onClick={retryListing}
                      disabled={pickersLocked}
                    >
                      Retry
                    </button>
                  )}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setTargetChosen(true)}
                    // The sign-in that fills this step is not a reason to
                    // refuse it. Anything else running is.
                    disabled={
                      pickersLocked ||
                      !orgForPicker ||
                      !workspaceTarget ||
                      workspaces === null
                    }
                  >
                    Continue
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={signOut}
                    disabled={busy !== null}
                  >
                    Sign out
                  </button>
                </div>
              </>
            ) : step > 2 ? (
              <p className="sub">
                <code>
                  {host?.org_slug ?? orgForPicker}/
                  {host?.workspace_slug ?? workspaceTarget}
                </code>
                {step === 3 && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => setTargetChosen(false)}
                      disabled={busy !== null}
                    >
                      change
                    </button>
                  </>
                )}
              </p>
            ) : null}
          </div>
        </li>

        <li className={stepClass(3)}>
          <span className="n">{stepMark(3)}</span>
          <div>
            <p className="headline">Register the agents on this machine</p>
            {step === 3 ? (
              <>
                <p className="sub">
                  Oxagen looks for the agents it can govern and, with your
                  go-ahead, writes its hooks into their settings. Untick any you
                  do not want recorded.
                </p>
                {scanError !== null && !detecting ? (
                  <p className="sub">
                    The scan did not finish, so it is not known which agents are
                    installed. Rescan to try again.
                  </p>
                ) : detecting || detected === null ? (
                  <p className="sub">Scanning this machine…</p>
                ) : (
                  <div className="agents">
                    {detected.harnesses.map((d) => (
                      <div
                        key={d.harness}
                        className={`agent ${d.installed ? "" : "absent"}`}
                      >
                        <label className={`check ${d.installed ? "" : "off"}`}>
                          <input
                            type="checkbox"
                            id={`register-${d.harness}`}
                            checked={(registration ?? []).includes(d.harness)}
                            disabled={!d.installed || busy !== null}
                            onChange={(e) =>
                              setRegistration((prev) => {
                                const list = prev ?? [];
                                return e.target.checked
                                  ? [...list, d.harness]
                                  : list.filter((h) => h !== d.harness);
                              })
                            }
                          />
                          <span className="name">{d.label}</span>
                        </label>
                        <span className="meta">
                          {d.installed
                            ? `${d.version ?? "installed"} · ${d.path}`
                            : "not found on this machine"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {detected !== null &&
                  !detecting &&
                  detected.harnesses.every((d) => !d.installed) && (
                    <div className="notice">
                      None of Claude Code, Codex, Cursor, or stella was found on
                      your PATH. Install one, then rescan:{" "}
                      {HARNESSES.map((h, i) => (
                        <span key={h}>
                          {i > 0 && " · "}
                          <code>{INSTALL_HINT[h]}</code>
                        </span>
                      ))}
                    </div>
                  )}
                {toolsTransient && (
                  <div className="notice">
                    {keepToolsHint}{" "}
                    <button
                      type="button"
                      className="quiet"
                      onClick={doInstallCli}
                      disabled={busy !== null}
                    >
                      {busy === "cli" ? "Copying…" : "Keep the tools"}
                    </button>
                  </div>
                )}
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={register}
                    disabled={
                      busy !== null ||
                      detecting ||
                      toolsTransient ||
                      (registration ?? []).length === 0
                    }
                  >
                    {busy === "enroll"
                      ? "Registering…"
                      : `Yes, register ${joinLabels(registration ?? []) || "agents"} with Oxagen`}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={rescan}
                    disabled={busy !== null || detecting}
                  >
                    Rescan
                  </button>
                </div>
                <p className="sub">
                  Running something else?{" "}
                  <a href="#" onClick={openDocs(WRAP_AGENT_URL)}>
                    Wrap your own agent
                  </a>{" "}
                  with <code>tacho hook</code> once this machine is set up.
                </p>
                {outcome && !outcome.ok && (
                  <div className="result fail" role="alert">
                    <span className="glyph" aria-hidden="true">
                      ✕
                    </span>
                    <div>
                      <p className="headline">Registration failed</p>
                      <p className="sub">{outcome.detail}</p>
                      <p className="sub">
                        Fix what the message names (a missing role in the org,
                        no network, an agent not on PATH), then try again. The
                        full output is in Activity below.
                      </p>
                    </div>
                  </div>
                )}
              </>
            ) : step > 3 ? (
              <p className="sub">{joinLabels(hostHarnesses)} · hooks written</p>
            ) : null}
          </div>
        </li>

        <li className={stepClass(4)}>
          <span className="n">{stepMark(4)}</span>
          <div>
            <p className="headline">Confirmation</p>
            {step === 4 && host ? (
              <>
                <div className="result" role="status">
                  <span className="glyph" aria-hidden="true">
                    ✓
                  </span>
                  <div>
                    <p className="headline">
                      This machine now reports to Oxagen as{" "}
                      <code>{host.agent_key}</code>
                    </p>
                    <p className="sub">
                      {outcome?.detail ??
                        `${joinLabels(hostHarnesses)} registered.`}{" "}
                      Reports to{" "}
                      <code>
                        {host.org_slug}/{host.workspace_slug}
                      </code>
                      ; collector {collectorText(daemonUp, host.port)};
                      enforcement is client-attested (the hooks the agents
                      honour).
                    </p>
                  </div>
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setOutcomeSeen(true)}
                    disabled={busy !== null}
                  >
                    Continue
                  </button>
                </div>
              </>
            ) : step > 4 ? (
              <p className="sub">
                Registered as <code>{host?.agent_key}</code>
              </p>
            ) : null}
          </div>
        </li>

        <li className={stepClass(5)}>
          <span className="n">5</span>
          <div>
            <p className="headline">Record a first run</p>
            {step === 5 && host ? (
              <>
                <p className="sub">
                  {runList.length > 0
                    ? `Oxagen sends each wrapped agent one small prompt ("reply OK") and confirms the run was recorded and sealed. That is your first data in the workspace.`
                    : `Nothing here to drive: every app you registered is a connected app, which Oxagen governs through its own MCP gateway rather than through a hook. There is no headless prompt to send one. It reports the first time you use it — open the workspace and watch it arrive.`}
                </p>
                <div className="agents">
                  {hostHarnesses.map((h) => (
                    <div key={h} className="agent">
                      {isConnected(h) ? (
                        // Registered, so it shows; not verifiable, so it gets
                        // no checkbox. `tacho verify` returns ok:false for a
                        // connected app by design — offering it as a target
                        // reported a failure for something that cannot succeed.
                        <span className="name">{labelOf(h)}</span>
                      ) : (
                        <label className="check">
                          <input
                            type="checkbox"
                            id={`run-${h}`}
                            checked={runList.includes(h)}
                            disabled={busy !== null}
                            onChange={(e) =>
                              setRunPicks(
                                e.target.checked
                                  ? [...new Set([...runList, h])]
                                  : runList.filter((x) => x !== h),
                              )
                            }
                          />
                          <span className="name">{labelOf(h)}</span>
                        </label>
                      )}
                      <span className="meta">
                        {isConnected(h)
                          ? "connected · reports when you use it"
                          : runs[h]
                            ? runs[h].ok
                              ? `recorded · ${runs[h].seq ?? "?"} events sealed`
                              : `failed · ${runs[h].detail}`
                            : busy === "connect"
                              ? "running…"
                              : "ready"}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="row">
                  {runList.length > 0 ? (
                    <button
                      type="button"
                      className={ranOnce ? "" : "primary"}
                      onClick={() => runConnect()}
                      disabled={busy !== null}
                    >
                      {busy === "connect"
                        ? "Running…"
                        : ranOnce
                          ? "Run again"
                          : "Yes, run the connect prompt"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={ranOnce || runList.length === 0 ? "primary" : ""}
                    onClick={openWorkspace}
                    disabled={!ranOnce && runList.length > 0}
                  >
                    Open this workspace in Oxagen
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setFirstRun(false)}
                    disabled={busy !== null}
                  >
                    {ranOnce ? "Finish" : "Skip for now"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </li>
      </ol>
      {(log.length > 0 || step >= 3) && activity}
    </>
  );

  // ── Later runs: the management pane ──────────────────────────────────────
  const change = pendingChange(host, {
    org: pickedOrg,
    workspace: pickedWorkspace,
    harnesses: null,
  });
  // Shown whether or not the machine is enrolled. It used to live only in
  // the enrolled pane, so after the last agent was de-registered nothing in
  // the app could remove the PATH links, the event log or the sign-in.
  const uninstallPanel = (
    <section className="panel" aria-labelledby="rm">
      <p className="eyebrow" id="rm">
        Uninstall
      </p>
      <p className="sub">
        Removes everything Oxagen put on this machine: the hooks in every
        wrapped agent's settings, the collector service, the host credentials
        and event log, the PATH links, and <code>~/.config/oxagen</code>.{" "}
        {uninstallHint}
      </p>
      <div className="row">
        {confirming === "uninstall-2" ? (
          <>
            <button
              type="button"
              className="danger"
              onClick={confirmed(uninstallEverything)}
              disabled={busy !== null}
            >
              Yes, remove Oxagen from this machine
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </>
        ) : confirming === "uninstall-1" ? (
          <>
            <span className="sub">
              {hostHarnesses.length > 0
                ? `This de-registers ${joinLabels(hostHarnesses)} and deletes the local event log. Sure?`
                : "This removes the command line links, the local event log and your sign-in on this machine. Sure?"}
            </span>
            <button
              type="button"
              className="danger"
              onClick={confirmed(() => askConfirm("uninstall-2"))}
              disabled={busy !== null}
            >
              I am sure
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="danger"
            onClick={() => askConfirm("uninstall-1")}
            disabled={busy !== null}
          >
            {busy === "uninstall" ? "Removing…" : "Uninstall Oxagen…"}
          </button>
        )}
      </div>
    </section>
  );

  const manage = host ? (
    <>
      <section className="panel" aria-labelledby="host">
        <p className="eyebrow" id="host">
          This machine
        </p>
        <p className="headline">{host.agent_key}</p>
        <dl className="kv">
          <dt>Reports to</dt>
          <dd>
            <code>
              {host.org_slug}/{host.workspace_slug}
            </code>
          </dd>
          <dt>Status</dt>
          <dd>
            {host.host_status}, {host.bundle.mode} mode
            {host.managed ? ", managed" : ""} · bundle v{host.bundle.version}{" "}
            fetched {ago(host.bundle_fetched_at)}
          </dd>
          <dt>Collector</dt>
          <dd>
            {state?.daemon
              ? `up ${state.daemon.uptime_s ?? "?"}s on 127.0.0.1:${host.port}, spool ${state.daemon.spool_depth ?? 0}, last ingest ${ago(state.daemon.last_ingest_at)}`
              : `not answering on 127.0.0.1:${host.port}`}
            {tacho?.service ? ` · ${serviceStatusText(tacho.service)}` : ""}
          </dd>
          <dt>Gateway</dt>
          <dd>{gatewayText(tacho, daemonUp, host.harnesses)}</dd>
          <dt>Agents</dt>
          <dd>{summarizeAgents(agentRows)}</dd>
          <dt>Signed in</dt>
          <dd>
            {loggedIn
              ? `${state?.config.org_slug ?? "—"} · CLI default workspace ${state?.config.workspace_slug ?? "—"}`
              : sessionExpired
                ? "session expired — sign in to change the workspace"
                : "not signed in"}
          </dd>
        </dl>
        <div className="row">
          <button type="button" onClick={openWorkspace}>
            Open this workspace in Oxagen
          </button>
          {loggedIn ? (
            <button
              type="button"
              className="quiet"
              onClick={signOut}
              disabled={busy !== null}
            >
              Sign out
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => signIn()}
              disabled={busy !== null}
            >
              {busy === "signin" ? "Waiting for the browser…" : "Sign in"}
            </button>
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="agents">
        <p className="eyebrow" id="agents">
          AI apps on this machine
        </p>
        <p className="sub">
          Every app Oxagen covers here, and what each one records. A{" "}
          <strong>wrapped</strong> agent runs an Oxagen hook, so every action it
          takes is recorded and can be refused — but Oxagen does not run it, so
          the record is what the agent reported. A <strong>connected</strong>{" "}
          app has no hook: Oxagen serves it a toolbelt and refuses the calls its
          mandate does not allow, and sees nothing else the app does. Neither
          covers what the other covers.
        </p>
        <div className="agents">
          {agentRows.map((row) => {
            const confirmKey = `dereg-${row.key}`;
            // With other agents left, de-registering is a `tacho reassign`,
            // which needs a working sign-in. Without one it would unenroll
            // the machine; the last agent's `unenroll` finishes offline.
            const signInFirst =
              !loggedIn &&
              deregisterNeedsSession(host.harnesses, row.key as Harness);
            const meta = [row.summary, ...row.details]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={row.key}
                className={`agent ${row.wrapped ? "" : "absent"}`}
              >
                <span className="name">{row.label}</span>
                <span
                  className={`badge health-${row.health}`}
                  aria-label={`Status: ${HEALTH_LABEL[row.health]}`}
                >
                  {HEALTH_LABEL[row.health]}
                </span>
                <span
                  className={`pill tier-${row.tier}`}
                  title={`${row.records} ${row.omits}`}
                >
                  {row.tierLabel}
                </span>
                <span className="meta">{meta}</span>
                {/*
                  Both lines, always. ADR-078 §2: a row that shows only what a
                  tier records reads as coverage it does not have, and the two
                  tiers do not rank against each other.
                */}
                <span className="records">
                  <span className="records-yes">Records: {row.records}</span>
                  <span className="records-no">{row.omits}</span>
                </span>
                {row.kind === "custom" ? (
                  <span className="pill">reports through tacho hook</span>
                ) : row.kind === "connected" && row.wrapped ? (
                  confirming === confirmKey ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        onClick={confirmed(() =>
                          deregister(row.key as Harness),
                        )}
                        disabled={busy !== null || signInFirst}
                      >
                        Confirm disconnect
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => askConfirm(confirmKey)}
                      disabled={busy !== null || signInFirst}
                      title={
                        signInFirst
                          ? "Sign in first"
                          : "Remove Oxagen's entry from this app's settings"
                      }
                    >
                      Disconnect…
                    </button>
                  )
                ) : row.wrapped ? (
                  confirming === confirmKey ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        onClick={confirmed(() =>
                          deregister(row.key as Harness),
                        )}
                        disabled={busy !== null || signInFirst}
                      >
                        Confirm de-register
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => runConnect([row.key as Harness])}
                        disabled={busy !== null}
                        title="Send one small prompt and confirm it was recorded"
                      >
                        Run connect prompt
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => askConfirm(confirmKey)}
                        disabled={busy !== null || signInFirst}
                        title={signInFirst ? "Sign in first" : undefined}
                      >
                        De-register…
                      </button>
                    </>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => addHarness(row.key as Harness)}
                    disabled={busy !== null || !loggedIn}
                    title={loggedIn ? undefined : "Sign in first"}
                  >
                    Register
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="sub">
          Running something else?{" "}
          <a href="#" onClick={openDocs(WRAP_AGENT_URL)}>
            Wrap your own agent
          </a>{" "}
          with <code>tacho hook</code>. No new install is needed.
        </p>
      </section>

      <section className="panel" aria-labelledby="ws">
        <p className="eyebrow" id="ws">
          Workspace
        </p>
        <p className="sub">
          Where this machine's sessions land. Changing it revokes the current
          enrollment and enrolls again; the device key, port and hooks stay.
        </p>
        <div className="row">
          {orgPicker}
          {workspacePicker}
          {listingRetry && (
            <button
              type="button"
              className="quiet"
              onClick={retryListing}
              disabled={pickersLocked}
            >
              Retry
            </button>
          )}
          {!loggedIn && <span className="pill">sign in to change</span>}
          {loggedIn && workspacePending && (
            <span className="pill">pick a workspace in {orgForPicker}</span>
          )}
        </div>
        {(change.target || workspacePending) && (
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={applyWorkspace}
              disabled={busy !== null || !loggedIn || workspacePending}
            >
              {busy === "apply"
                ? "Applying…"
                : workspacePending
                  ? `Reassign to ${orgForPicker}/…`
                  : `Reassign to ${orgForPicker}/${workspaceTarget}`}
            </button>
            <label className="check">
              <input
                type="checkbox"
                id="also-default"
                checked={alsoDefault}
                onChange={(e) => setAlsoDefault(e.target.checked)}
              />
              also make it the CLI default
            </label>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setPickedOrg(null);
                setPickedWorkspace(null);
              }}
            >
              Reset
            </button>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="cli">
        <p className="eyebrow" id="cli">
          Command line
        </p>
        <p className="sub">
          <code>oxagen</code> and <code>tacho</code> ship inside the app.
          Linking puts them on your PATH.
        </p>
        {cliInstallNote && <p className="sub">{cliInstallNote}</p>}
        <dl className="kv">
          <dt>oxagen</dt>
          <dd>
            {state?.oxagen_on_path ? (
              <code>{state.oxagen_on_path}</code>
            ) : (
              "not on PATH"
            )}
          </dd>
          <dt>tacho</dt>
          <dd>
            {state?.tacho_on_path ? (
              <code>{state.tacho_on_path}</code>
            ) : (
              "not on PATH"
            )}
          </dd>
        </dl>
        <div className="row">
          <button type="button" onClick={doInstallCli} disabled={busy !== null}>
            {cliLinksPresent ? "Relink" : "Link into"}{" "}
            <code>{state?.cli_install_dir}</code>
          </button>
          <button
            type="button"
            className="quiet"
            onClick={doRemoveCliLinks}
            disabled={busy !== null || !cliLinksPresent}
          >
            {busy === "cli-remove" ? "Removing…" : "Remove links"}
          </button>
        </div>
      </section>

      {skewNote && (
        <section className="panel" aria-label="Tools out of date">
          <p className="sub">{skewNote}</p>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                act("reapply", "tacho", ["enroll"], () =>
                  setNotice(
                    "Hooks and the collector re-applied from this app.",
                  ),
                )
              }
              disabled={busy !== null}
            >
              Re-apply
            </button>
          </div>
        </section>
      )}

      {activity}

      {!uninstalled && uninstallPanel}
    </>
  ) : (
    <>
      <section className="panel">
        <p className="headline">
          {uninstalled
            ? "Oxagen was removed from this machine"
            : "Oxagen is no longer set up on this machine"}
        </p>
        <p className="sub">
          {notice ?? "Run the setup again to register your agents."}
        </p>
        {retiredHost && (
          <p className="sub">
            This machine was unenrolled while offline. {retiredHost.agent_key}{" "}
            still shows as active on the fleet page until the revoke goes
            through: sign in and uninstall, or revoke it from the fleet page.
          </p>
        )}
        <div className="row">
          <button type="button" className="primary" onClick={restartWizard}>
            Set up again
          </button>
        </div>
      </section>
      {activity}
      {!uninstalled && uninstallPanel}
    </>
  );

  return (
    <>
      <header className="masthead">
        <span className="wordmark">
          o<span className="x">x</span>agen
        </span>
        <span className="spacer" />
        <span className="version">
          <span className={`dot ${dotClass}`} aria-hidden="true" />
          {!host
            ? "not set up"
            : daemonUp
              ? `connected · ${host.host_status}`
              : "enrolled · collector not answering"}
          {state ? ` · v${state.app_version}` : ""}
        </span>
        <a
          className="guide-link"
          href="#"
          onClick={openDocs(DESKTOP_GUIDE_URL)}
        >
          Desktop app guide
        </a>
        <span className="updates">
          {update.caption && (
            <span className="sub" role="status">
              {update.caption}
            </span>
          )}
          {update.offered && busy !== "update" ? (
            <button
              type="button"
              onClick={doInstallUpdate}
              disabled={busy !== null || checking || !state}
            >
              Install
            </button>
          ) : (
            <button
              type="button"
              className="quiet"
              onClick={doCheckUpdate}
              // Only an install in progress stops a check; nothing else
              // running on the machine does.
              disabled={checking || busy === "update" || !state}
            >
              Check for updates
            </button>
          )}
        </span>
      </header>

      <main>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {notice && !error && (firstRun || host) && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {state === null ? (
          <p className="sub">Reading this machine…</p>
        ) : state.host_error ? (
          <section className="panel" aria-label="Enrollment file unreadable">
            <p className="headline">
              This machine's enrollment could not be read
            </p>
            <p className="sub">
              {state.host_path}: {state.host_error}. The machine may still be
              enrolled, so setup is not offered here, because it would write
              over that file. Run <code>tacho status</code> in a terminal to see
              what is in place, or <code>tacho unenroll</code> to remove it,
              then reopen Oxagen.
            </p>
          </section>
        ) : firstRun ? (
          wizard
        ) : (
          manage
        )}
      </main>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-glyph" aria-hidden="true">
            ✓
          </span>
          <span>{toast}</span>
          <button
            type="button"
            className="quiet"
            onClick={() => setToast(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
