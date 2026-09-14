/**
 * The Oxagen app, one pane on paper.
 *
 * First run (no enrollment on this machine): a five-step wizard — sign in,
 * pick the org and workspace the operator can see, register the agents the
 * machine has (Claude Code, Codex; detected, all ticked by default), the
 * outcome, then a recorded first run and the door to Mission Control.
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
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConnectResult,
  connectRun,
  type DesktopState,
  type DetectReport,
  detectHarnesses,
  installCli,
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
  defaultRegistration,
  deregisterArgs,
  enrollArgs,
  HARNESS_LABEL,
  type Harness,
  loginArgs,
  missionControlUrl,
  needsWorkspacePick,
  pendingChange,
  reassignArgs,
  unenrollArgs,
  wizardStep,
} from "./commands";
import { checkForUpdate, describeCheck, installUpdate } from "./updater";

interface LogLine {
  text: string;
  err: boolean;
}

interface RunOutcome {
  code: number | null;
  stderr: string;
}

/** `api_post` rejects with "401: ..." when the session token is dead. */
function isUnauthorized(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /^401\b/.test(text);
}

const HARNESSES: Harness[] = ["claude-code", "codex"];
const labelOf = (h: string) => HARNESS_LABEL[h as Harness] ?? h;
const joinLabels = (list: readonly string[]) => list.map(labelOf).join(" and ");

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [tacho, setTacho] = useState<TachoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Bumped after every sign-in so the org listing runs again: config.json's
  // `logged_in` is presence-only and stays true across an expired session
  // being replaced, so the boolean alone never re-triggers the listing.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [orgs, setOrgs] = useState<OrgItem[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[] | null>(null);
  const [pickedOrg, setPickedOrg] = useState<string | null>(null);
  const [pickedWorkspace, setPickedWorkspace] = useState<string | null>(null);
  const [tail, setTail] = useState<string>("");
  const [update, setUpdate] = useState<{
    caption: string | null;
    offered: Update | null;
  }>({ caption: null, offered: null });
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

  const refresh = useCallback(async (withHooks = false) => {
    try {
      const next = await readState();
      setState(next);
      setFirstRun((prev) => (prev === null ? next.host === null : prev));
      if (!next.host) setTacho(null);
      else if (withHooks) {
        try {
          setTacho(await tachoStatus());
          statusErrorRef.current = null;
        } catch (e) {
          // Hook presence, service state and WAL figures are now unknown;
          // say so once, and keep the rest of the panel reading the files.
          setTacho(null);
          const text = `tacho status failed: ${e instanceof Error ? e.message : String(e)}`;
          if (statusErrorRef.current !== text) {
            statusErrorRef.current = text;
            setError(text);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    let tick = 0;
    pollRef.current = window.setInterval(() => {
      tick += 1;
      void refresh(tick % 4 === 0);
    }, 5000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const host = state?.host ?? null;
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
      return;
    }
    let cancelled = false;
    listOrganizations()
      .then((list) => {
        if (!cancelled) {
          setOrgs(list);
          setSessionExpired(false);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setOrgs([]);
        if (isUnauthorized(e)) setSessionExpired(true);
        else
          setError(
            `Could not list organizations: ${e instanceof Error ? e.message : String(e)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [configToken, sessionEpoch]);
  useEffect(() => {
    if (!loggedIn || !orgForPicker) {
      setWorkspaces(null);
      return;
    }
    let cancelled = false;
    listWorkspaces(orgForPicker)
      .then((list) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setWorkspaces([]);
        if (isUnauthorized(e)) setSessionExpired(true);
        else
          setError(
            `Could not list workspaces of ${orgForPicker}: ${e instanceof Error ? e.message : String(e)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [loggedIn, orgForPicker]);

  const step = wizardStep({
    loggedIn,
    targetChosen,
    enrolled: host !== null,
    outcomeSeen,
  });

  // Step 3 opens with a scan of the machine.
  useEffect(() => {
    if (firstRun !== true || step !== 3 || detected !== null || detecting)
      return;
    let cancelled = false;
    setDetecting(true);
    detectHarnesses()
      .then((report) => {
        if (cancelled) return;
        setDetected(report ?? { enrolled: false, harnesses: [] });
        if (report) setRegistration(defaultRegistration(report.harnesses));
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(
            `Could not scan for agents: ${e instanceof Error ? e.message : String(e)}`,
          );
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [firstRun, step, detected, detecting]);

  async function act(
    name: string,
    sidecar: "tacho" | "oxagen",
    args: string[],
    after?: (result: RunOutcome) => Promise<void> | void,
    onFail?: (result: RunOutcome) => void,
  ) {
    setBusy(name);
    setError(null);
    setNotice(null);
    setConfirming(null);
    setLog([{ text: `$ ${sidecar} ${args.join(" ")}`, err: false }]);
    try {
      const result = await runSidecar(sidecar, args, (line, stream) =>
        setLog((prev) => [...prev, { text: line, err: stream === "stderr" }]),
      );
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
      setBusy(null);
      await refresh(true);
    }
  }

  // `oxagen login --browser` replaces whatever session config.json holds,
  // so a sign-in after a 401 (or a Switch organization) starts the pickers
  // over from the new session rather than keeping the dead one's verdict.
  const signIn = () =>
    act("signin", "oxagen", loginArgs(), () => {
      setSessionExpired(false);
      setSessionEpoch((n) => n + 1);
      setPickedOrg(null);
      setPickedWorkspace(null);
      setNotice("Signed in.");
    });
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
        setRunPicks(chosen);
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
    const picks = only ?? runPicks ?? hostHarnesses;
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

  const openMissionControl = () => {
    if (!state || !host) return;
    void openUrl(
      missionControlUrl(
        state.config.app_url,
        host.org_slug,
        host.workspace_slug,
      ),
    );
  };

  const applyWorkspace = () => {
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
    return act("apply", call.sidecar, call.args, () => {
      setPickedOrg(null);
      setPickedWorkspace(null);
      setNotice("Reassigned; the device key was kept.");
    });
  };

  const deregister = (h: Harness) => {
    if (!host) return;
    const call = deregisterArgs(host.harnesses, h);
    return act("deregister", call.sidecar, call.args, () =>
      setNotice(
        call.args[0] === "unenroll"
          ? `${labelOf(h)} was the last wrapped agent: hooks, service and credentials removed.`
          : `${labelOf(h)} de-registered; its hooks are removed.`,
      ),
    );
  };

  const addHarness = (h: Harness) =>
    host &&
    act(
      "add",
      "tacho",
      ["reassign", "--harness", [...host.harnesses, h].join(",")],
      () => setNotice(`${labelOf(h)} is now wrapped.`),
    );

  async function uninstallEverything() {
    setConfirming(null);
    setBusy("uninstall");
    setError(null);
    setNotice(null);
    setLog([{ text: "$ tacho unenroll --purge", err: false }]);
    try {
      const result = await runSidecar("tacho", unenrollArgs(true), (line, s) =>
        setLog((prev) => [...prev, { text: line, err: s === "stderr" }]),
      );
      if (result.code !== 0)
        throw new Error(`tacho unenroll exited ${result.code ?? "?"}`);
      const removed = await uninstallCli();
      setLog((prev) => [
        ...prev,
        {
          text: `removed PATH links: ${removed.join(", ") || "none"}`,
          err: false,
        },
      ]);
      const dir = await removeLocalData();
      setLog((prev) => [...prev, { text: `removed ${dir}`, err: false }]);
      setNotice(
        `Everything Oxagen put on this machine is gone. ${uninstallHint}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh(true);
    }
  }

  async function doInstallCli() {
    setBusy("cli");
    setError(null);
    try {
      const r = await installCli();
      setNotice(`${r.files.length} links in ${r.dir}. ${r.note}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  }
  async function showLog() {
    setTail(await logTail(120));
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
    if (!state) return;
    setBusy("update");
    setError(null);
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
      setBusy(null);
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
      await installUpdate(offered, (line) =>
        setLog((prev) => [...prev, { text: line, err: false }]),
      );
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
    setFirstRun(true);
    setTargetChosen(false);
    setDetected(null);
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
  const dotClass = !host
    ? ""
    : daemonUp && host.host_status === "active"
      ? "on"
      : "half";

  const orgPicker = (
    <select
      aria-label="Organization"
      id="org"
      value={orgForPicker ?? ""}
      onChange={(e) => {
        setPickedOrg(e.target.value);
        setPickedWorkspace(null);
      }}
      disabled={busy !== null || orgs === null}
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
      disabled={busy !== null || workspaces === null}
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
  const runList = runPicks ?? hostHarnesses;

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
                  are done.
                </p>
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={signIn}
                    disabled={busy !== null}
                  >
                    {busy === "signin" ? "Waiting for the browser…" : "Sign in"}
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
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setTargetChosen(true)}
                    disabled={
                      busy !== null ||
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
                {detecting || detected === null ? (
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
                      Neither Claude Code nor Codex was found on your PATH.
                      Install one (
                      <code>npm i -g @anthropic-ai/claude-code</code> or{" "}
                      <code>npm i -g @openai/codex</code>), then rescan.
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
                    onClick={() => setDetected(null)}
                    disabled={busy !== null || detecting}
                  >
                    Rescan
                  </button>
                </div>
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
                      ; collector{" "}
                      {daemonUp
                        ? `running on 127.0.0.1:${host.port}`
                        : "starting…"}
                      ; enforcement is client-attested (the hooks the agents
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
                  Oxagen sends each registered agent one small prompt ("reply
                  OK") and confirms the run was recorded and sealed. That is
                  your first data in Mission Control.
                </p>
                <div className="agents">
                  {hostHarnesses.map((h) => (
                    <div key={h} className="agent">
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
                      <span className="meta">
                        {runs[h]
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
                  <button
                    type="button"
                    className={ranOnce ? "" : "primary"}
                    onClick={() => runConnect()}
                    disabled={busy !== null || runList.length === 0}
                  >
                    {busy === "connect"
                      ? "Running…"
                      : ranOnce
                        ? "Run again"
                        : "Yes, run the connect prompt"}
                  </button>
                  <button
                    type="button"
                    className={ranOnce ? "primary" : ""}
                    onClick={openMissionControl}
                    disabled={!ranOnce}
                  >
                    Open Mission Control
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
            {tacho?.service
              ? ` · ${tacho.service.kind} ${tacho.service.running ? "running" : tacho.service.installed ? "installed, stopped" : "not installed"}`
              : ""}
          </dd>
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
          <button type="button" onClick={openMissionControl}>
            Open Mission Control
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
              onClick={signIn}
              disabled={busy !== null}
            >
              {busy === "signin" ? "Waiting for the browser…" : "Sign in"}
            </button>
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="agents">
        <p className="eyebrow" id="agents">
          Wrapped agents
        </p>
        <p className="sub">
          Each agent Oxagen records on this machine. De-registering removes
          Oxagen's hooks from that agent's settings; the last one also stops the
          collector and deletes the host credentials.
        </p>
        <div className="agents">
          {HARNESSES.map((h) => {
            const enrolled = hostHarnesses.includes(h);
            const presence =
              h === "claude-code" ? tacho?.hooks : tacho?.codexHooks;
            const version =
              h === "claude-code" ? host.claude_version : host.codex_version;
            const key = `dereg-${h}`;
            const meta = enrolled
              ? [
                  version ?? "",
                  presence
                    ? presence.complete
                      ? "hooks complete"
                      : `${presence.missing.length} hooks missing`
                    : "",
                  runs[h]?.ok ? "first run recorded" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "not wrapped";
            return (
              <div key={h} className={`agent ${enrolled ? "" : "absent"}`}>
                <span className="name">{labelOf(h)}</span>
                <span className="meta">{meta}</span>
                {enrolled ? (
                  confirming === key ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => deregister(h)}
                        disabled={busy !== null}
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
                        onClick={() => runConnect([h])}
                        disabled={busy !== null}
                        title="Send one small prompt and confirm it was recorded"
                      >
                        Run connect prompt
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setConfirming(key)}
                        disabled={busy !== null}
                      >
                        De-register…
                      </button>
                    </>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => addHarness(h)}
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
          <code>oxagen</code> and <code>tacho</code> ship inside the app;
          linking puts them on your PATH.
        </p>
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
            {state?.oxagen_on_path ? "Relink" : "Link into"}{" "}
            <code>{state?.cli_install_dir}</code>
          </button>
        </div>
      </section>

      {activity}

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
                onClick={uninstallEverything}
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
                This de-registers {joinLabels(hostHarnesses)} and deletes the
                local event log. Sure?
              </span>
              <button
                type="button"
                className="danger"
                onClick={() => setConfirming("uninstall-2")}
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
              onClick={() => setConfirming("uninstall-1")}
              disabled={busy !== null}
            >
              {busy === "uninstall" ? "Removing…" : "Uninstall Oxagen…"}
            </button>
          )}
        </div>
      </section>
    </>
  ) : (
    <>
      <section className="panel">
        <p className="headline">Oxagen is no longer set up on this machine</p>
        <p className="sub">
          {notice ?? "Run the setup again to register your agents."}
        </p>
        <div className="row">
          <button type="button" className="primary" onClick={restartWizard}>
            Set up again
          </button>
        </div>
      </section>
      {activity}
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
              disabled={busy !== null || !state}
            >
              Install
            </button>
          ) : (
            <button
              type="button"
              className="quiet"
              onClick={doCheckUpdate}
              disabled={busy !== null || !state}
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
        ) : firstRun ? (
          wizard
        ) : (
          manage
        )}
      </main>
    </>
  );
}
