/**
 * The management UI: one column of panels that each read the machine's real
 * state and drive one sidecar action. The gold primary moves with the next
 * step (sign in → enroll → apply a pending change) and is never on a
 * destructive control; those use the danger treatment.
 */
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DesktopState,
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
  enrollArgs,
  HARNESS_LABEL,
  type Harness,
  pendingChange,
  primaryAction,
  reassignArgs,
  toggleHarness as toggle,
  unenrollArgs,
} from "./commands";
import { checkForUpdate, describeCheck, installUpdate } from "./updater";

interface LogLine {
  text: string;
  err: boolean;
}

/** `api_post` rejects with "401: ..." when the session token is dead. */
function isUnauthorized(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /^401\b/.test(text);
}

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [tacho, setTacho] = useState<TachoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgItem[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[] | null>(null);
  const [pickedOrg, setPickedOrg] = useState<string | null>(null);
  const [pickedWorkspace, setPickedWorkspace] = useState<string | null>(null);
  const [pickedHarnesses, setPickedHarnesses] = useState<Harness[] | null>(
    null,
  );
  /** The masthead's update control: idle, the last check's caption, or the
   *  offered build waiting for "Install". */
  const [update, setUpdate] = useState<{
    caption: string | null;
    offered: Update | null;
  }>({ caption: null, offered: null });
  const [purge, setPurge] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [tail, setTail] = useState<string>("");
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async (withHooks = false) => {
    try {
      const next = await readState();
      setState(next);
      if (withHooks && next.host) setTacho(await tachoStatus());
      if (!next.host) setTacho(null);
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
  const [sessionExpired, setSessionExpired] = useState(false);
  const loggedIn = (state?.config.logged_in ?? false) && !sessionExpired;
  const daemonUp = state?.daemon != null;
  const hostOrg = host?.org_slug ?? null;

  // Workspaces of the host's org (or the signed-in org before enrollment).
  const orgForPicker = pickedOrg ?? hostOrg ?? state?.config.org_slug ?? null;
  // A token in config.json is "signed in" until the control plane says
  // otherwise; a 401 from the first user-scoped call marks the session dead.
  const configToken = state?.config.logged_in ?? false;
  const sessionValid = configToken && !sessionExpired;
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
  }, [configToken]);
  useEffect(() => {
    if (!sessionValid || !orgForPicker) {
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
  }, [sessionValid, orgForPicker]);

  const currentHarnesses = useMemo<Harness[]>(
    () => (host?.harnesses ?? ["claude-code"]) as Harness[],
    [host],
  );
  const harnesses = pickedHarnesses ?? currentHarnesses;
  const picks = {
    org: pickedOrg,
    workspace: pickedWorkspace,
    harnesses: pickedHarnesses,
  };
  const change = pendingChange(host, picks);
  const harnessChanged = change.harness;
  const targetChanged = change.target;
  const workspaceTarget = pickedWorkspace ?? host?.workspace_slug ?? null;
  const primary = primaryAction(loggedIn, host !== null, change);

  async function act(
    name: string,
    sidecar: "tacho" | "oxagen",
    args: string[],
    after?: () => Promise<void> | void,
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
      } else {
        await after?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh(true);
    }
  }

  const signIn = () =>
    act("signin", "oxagen", ["login"], () => {
      setNotice("Signed in.");
    });
  const signOut = () =>
    act("signout", "oxagen", ["logout"], () => {
      setOrgs(null);
      setWorkspaces(null);
      setPickedOrg(null);
      setPickedWorkspace(null);
    });
  const resetPicks = () => {
    setPickedOrg(null);
    setPickedWorkspace(null);
    setPickedHarnesses(null);
  };
  const enroll = () =>
    act("enroll", "tacho", enrollArgs({ ...picks, harnesses }), () => {
      resetPicks();
      setNotice("This machine now reports to Oxagen.");
    });
  // "also make it the CLI default": the reassign runs as `oxagen tacho
  // reassign … --default` so config.json's pair follows host.json's.
  const [alsoDefault, setAlsoDefault] = useState(true);
  const apply = () => {
    if (!host) return;
    const call = reassignArgs(host, picks, alsoDefault);
    return act("apply", call.sidecar, call.args, () => {
      resetPicks();
      setNotice(
        alsoDefault
          ? "Reassigned; the device key was kept and the CLI default follows."
          : "Reassigned; the device key was kept.",
      );
    });
  };
  const unenroll = () =>
    act("unenroll", "tacho", unenrollArgs(purge), () => {
      setNotice(
        "Unenrolled: hooks removed, service stopped, credentials deleted.",
      );
    });

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
  async function doUninstallCli() {
    setBusy("cli");
    setError(null);
    try {
      const removed = await uninstallCli();
      setNotice(
        removed.length > 0
          ? `Removed ${removed.join(", ")}.`
          : "Nothing to remove.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  }
  async function doRemoveData() {
    setBusy("remove");
    setError(null);
    setConfirming(null);
    try {
      const dir = await removeLocalData();
      setNotice(`Removed ${dir}. Drag Oxagen to the Trash to finish.`);
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

  const toggleHarness = (h: Harness) =>
    setPickedHarnesses(toggle(harnesses, h));

  const dotClass = !host
    ? ""
    : daemonUp && host.host_status === "active"
      ? "on"
      : "half";
  const uninstallHint =
    state?.platform === "macos"
      ? "then drag Oxagen from Applications to the Trash."
      : state?.platform === "windows"
        ? "then remove Oxagen from Settings › Apps."
        : "then remove the package (apt/dnf) or delete the AppImage.";

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
            ? "not enrolled"
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
        {notice && !error && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}

        {/* Account */}
        <section className="panel" aria-labelledby="acct">
          <p className="eyebrow" id="acct">
            Account
          </p>
          {loggedIn ? (
            <>
              <p className="headline">
                Signed in to {state?.config.org_slug ?? "an organization"}
              </p>
              <p className="sub">
                CLI default workspace:{" "}
                <code>{state?.config.workspace_slug ?? "—"}</code> ·{" "}
                <code>{state?.config.api_url}</code>
              </p>
              <div className="row">
                <button
                  type="button"
                  onClick={signIn}
                  disabled={busy !== null}
                  title="Opens the browser; pick another organization there"
                >
                  Switch organization…
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={signOut}
                  disabled={busy !== null}
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="headline">
                {sessionExpired ? "Session expired" : "Not signed in"}
              </p>
              <p className="sub">
                {sessionExpired
                  ? `The saved session for ${state?.config.org_slug ?? "your organization"} is no longer valid. `
                  : ""}
                Sign in opens your browser; the org and workspace you choose
                there become the CLI's defaults.
              </p>
              <div className="row">
                <button
                  type="button"
                  className={primary === "signin" ? "primary" : ""}
                  onClick={signIn}
                  disabled={busy !== null}
                >
                  {busy === "signin" ? "Waiting for the browser…" : "Sign in"}
                </button>
              </div>
            </>
          )}
        </section>

        {/* Host */}
        <section className="panel" aria-labelledby="host">
          <p className="eyebrow" id="host">
            This machine
          </p>
          {host ? (
            <>
              <p className="headline">{host.agent_key}</p>
              <dl className="kv">
                <dt>Reports to</dt>
                <dd>
                  <code>
                    {host.org_slug}/{host.workspace_slug}
                  </code>
                </dd>
                <dt>Enrollment</dt>
                <dd>
                  <code>{host.host_enrollment_id}</code>
                  {host.revoked_at ? ` · revoked ${ago(host.revoked_at)}` : ""}
                </dd>
                <dt>Status</dt>
                <dd>
                  {host.host_status}, {host.bundle.mode} mode
                  {host.managed ? ", managed" : ""} · bundle v
                  {host.bundle.version} fetched {ago(host.bundle_fetched_at)}
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
                <dt>Attestation</dt>
                <dd>
                  client attested (hooks the harness honours); managed settings
                  lock them on MDM-managed machines
                </dd>
                <dt>Expires</dt>
                <dd>{host.expires_at.slice(0, 10)}</dd>
              </dl>
              <div className="row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={purge}
                    onChange={(e) => setPurge(e.target.checked)}
                  />
                  also delete the local event log
                </label>
                {confirming === "unenroll" ? (
                  <>
                    <button
                      type="button"
                      className="danger"
                      onClick={unenroll}
                      disabled={busy !== null}
                    >
                      Confirm unenroll
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
                    onClick={() => setConfirming("unenroll")}
                    disabled={busy !== null}
                  >
                    Unenroll this machine…
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="headline">Not enrolled</p>
              <p className="sub">
                Enrolling generates a device key, installs the collector as a
                user service, and writes the hooks for the wrappers you pick
                below.
              </p>
              {loggedIn && (
                <div className="row">
                  <select
                    aria-label="Organization"
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
                    {orgs !== null &&
                      orgForPicker &&
                      !orgs.some((o) => o.slug === orgForPicker) && (
                        <option value={orgForPicker}>{orgForPicker}</option>
                      )}
                  </select>
                  <select
                    aria-label="Workspace"
                    value={
                      pickedWorkspace ?? state?.config.workspace_slug ?? ""
                    }
                    onChange={(e) => setPickedWorkspace(e.target.value)}
                    disabled={busy !== null || workspaces === null}
                  >
                    {(workspaces ?? []).map((w) => (
                      <option key={w.slug} value={w.slug}>
                        {w.name} ({w.slug})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={primary === "enroll" ? "primary" : ""}
                    onClick={enroll}
                    disabled={busy !== null}
                  >
                    {busy === "enroll" ? "Enrolling…" : "Enroll this machine"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {/* Workspace (enrolled) */}
        {host && (
          <section className="panel" aria-labelledby="ws">
            <p className="eyebrow" id="ws">
              Workspace
            </p>
            <p className="sub">
              Where this machine's sessions land. Changing it revokes the
              current enrollment and enrolls again; the device key, port and
              hooks stay.
            </p>
            <div className="row">
              <select
                aria-label="Organization"
                value={orgForPicker ?? ""}
                onChange={(e) => {
                  setPickedOrg(e.target.value);
                  setPickedWorkspace(null);
                }}
                disabled={busy !== null || !loggedIn || orgs === null}
              >
                {(orgs ?? []).map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.name} ({o.slug})
                  </option>
                ))}
                {orgForPicker &&
                  !(orgs ?? []).some((o) => o.slug === orgForPicker) && (
                    <option value={orgForPicker}>{orgForPicker}</option>
                  )}
              </select>
              <select
                aria-label="Workspace"
                value={workspaceTarget ?? ""}
                onChange={(e) => setPickedWorkspace(e.target.value)}
                disabled={busy !== null || !loggedIn || workspaces === null}
              >
                {(workspaces ?? []).map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.name} ({w.slug})
                  </option>
                ))}
                {workspaceTarget &&
                  !(workspaces ?? []).some(
                    (w) => w.slug === workspaceTarget,
                  ) && (
                    <option value={workspaceTarget}>{workspaceTarget}</option>
                  )}
              </select>
              {!loggedIn && <span className="pill">sign in to change</span>}
            </div>
          </section>
        )}

        {/* Wrappers */}
        <section className="panel" aria-labelledby="wrap">
          <p className="eyebrow" id="wrap">
            Wrappers
          </p>
          <p className="sub">
            Which agents on this machine are recorded and gated.
          </p>
          <div className="row">
            {(Object.keys(HARNESS_LABEL) as Harness[]).map((h) => {
              const detected =
                h === "claude-code"
                  ? host?.claude_version
                  : host?.codex_version;
              const presence =
                h === "claude-code" ? tacho?.hooks : tacho?.codexHooks;
              return (
                <label className="check" key={h}>
                  <input
                    type="checkbox"
                    checked={harnesses.includes(h)}
                    onChange={() => toggleHarness(h)}
                    disabled={busy !== null}
                  />
                  {HARNESS_LABEL[h]}
                  {host && harnesses.includes(h) && (
                    <span
                      className={`pill ${presence?.complete ? "strong" : ""}`}
                    >
                      {presence
                        ? presence.complete
                          ? "hooks complete"
                          : `${presence.missing.length} hooks missing`
                        : "checking…"}
                      {detected ? ` · ${detected}` : ""}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {host && (targetChanged || harnessChanged) && (
            <div className="row">
              <button
                type="button"
                className={primary === "apply" ? "primary" : ""}
                onClick={apply}
                disabled={busy !== null || !loggedIn}
              >
                {busy === "apply"
                  ? "Applying…"
                  : targetChanged
                    ? `Reassign to ${orgForPicker}/${workspaceTarget}`
                    : "Apply wrappers"}
              </button>
              <button type="button" className="quiet" onClick={resetPicks}>
                Reset
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={alsoDefault}
                  onChange={(e) => setAlsoDefault(e.target.checked)}
                  disabled={busy !== null}
                />
                also make it the CLI default
              </label>
            </div>
          )}
        </section>

        {/* CLI */}
        <section className="panel" aria-labelledby="cli">
          <p className="eyebrow" id="cli">
            Command line
          </p>
          <p className="sub">
            <code>oxagen</code> and <code>tacho</code> ship inside the app.
            Linking puts them on your PATH.
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
            <button
              type="button"
              onClick={doInstallCli}
              disabled={busy !== null}
            >
              {state?.oxagen_on_path ? "Relink" : "Link into"}{" "}
              <code>{state?.cli_install_dir}</code>
            </button>
            <button
              type="button"
              className="quiet"
              onClick={doUninstallCli}
              disabled={busy !== null}
            >
              Remove links
            </button>
          </div>
        </section>

        {/* Output + logs */}
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
                onClick={() => state && void openPath(state.log_path)}
              >
                Open {state?.log_path}
              </button>
            </div>
          </details>
        </section>

        {/* Remove */}
        <section className="panel" aria-labelledby="rm">
          <p className="eyebrow" id="rm">
            Uninstall
          </p>
          <p className="sub">
            Unenroll above first (that removes the hooks and the service),
            remove the local data here, {uninstallHint}
          </p>
          <div className="row">
            {confirming === "remove" ? (
              <>
                <button
                  type="button"
                  className="danger"
                  onClick={doRemoveData}
                  disabled={busy !== null || host !== null}
                >
                  Confirm: delete local data
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
                onClick={() => setConfirming("remove")}
                disabled={busy !== null || host !== null}
                title={host ? "Unenroll first" : undefined}
              >
                Remove local data…
              </button>
            )}
            <button
              type="button"
              className="quiet"
              onClick={() =>
                state && void openUrl(`${state.config.app_url}/settings/fleet`)
              }
            >
              Fleet page
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
