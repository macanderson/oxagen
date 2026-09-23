/**
 * `tacho unenroll` (spec section 5.1, acceptance 18): strip Tacho's hook
 * entries and env keys (every foreign entry survives), stop and remove the
 * service, revoke the enrollment on the control plane, and delete the host
 * key and credentials. The WAL stays for inspection unless `--purge`.
 *
 * `revoked_at` in host.json means "retired on this machine at": the hooks
 * are gone and no `enroll` re-applies them. It says nothing about the
 * control plane — a revoke that could not be made (offline, no token) is
 * retried by the next `unenroll` or `reassign`, and the handler answers
 * idempotently for one that already went through.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { acquireInstallLock } from "../host/install-lock";
import { stripClaudeDesktopConfig } from "../host/claude-desktop-writer";
import { stripCodexHooks } from "../host/codex-writer";
import {
  cursorDocumentIsVestigial,
  stripCursorHooks,
} from "../host/cursor-writer";
import type { McpServerEntry } from "../host/mcp-config-writer";
import {
  type HostFile,
  modelProxyPortFor,
  readHostFileLenient,
  writeHostFile,
} from "../host/host-file";
import { restoreGithubRepositories } from "./github";
import { restoreCredentials } from "./credential";
import {
  modelBaseUrlBackupPath,
  hasOrphanedModelBaseUrl,
  type ModelBaseUrlHarness,
} from "../host/model-base-url";
import { stripTachoSettings } from "../host/settings-writer";
import { stripStellaHooks } from "../host/stella-writer";
import { toProtocolTimestamp } from "../timestamp";
import { MODEL_ROUTED_HARNESSES } from "../wire";
import {
  type CliDeps,
  type CredentialOptions,
  resolveCredentials,
} from "./deps";

export interface UnenrollOptions extends CredentialOptions {
  purge?: boolean;
  reason?: string;
}

export interface UnenrollResult {
  /**
   * False when something of Tacho's is still on the machine: a harness file
   * that could not be cleaned, a service that would not unload. An offline
   * revoke is not a failure (the host is retired here and host.json is kept
   * so the revoke can be finished); `revoked` reports it.
   */
  ok: boolean;
  settingsChanged: boolean;
  revoked: boolean;
  warnings: string[];
}

/**
 * Revoke a host's enrollment on the control plane with the operator's
 * credentials. Returns true on success; every failure lands in `warnings`
 * because a host must be able to unenroll offline (the record stays marked
 * revoked locally until an operator finishes it).
 */
export async function revokeOnControlPlane(
  host: HostFile,
  options: CredentialOptions & { reason?: string },
  deps: CliDeps,
  warnings: string[],
): Promise<boolean> {
  const resolved = resolveCredentials(
    {
      apiUrl: host.api_url,
      org: options.org ?? host.org_slug,
      workspace: options.workspace ?? host.workspace_slug,
      ...(options.token !== undefined ? { token: options.token } : {}),
    },
    deps.env,
    deps.home,
  );
  if ("missing" in resolved) {
    warnings.push(
      "no operator token; the host stays active server-side until an operator revokes it (`oxagen login`, then `tacho unenroll` again, or revoke from the fleet page)",
    );
    return false;
  }
  const { credentials } = resolved;
  try {
    const response = await deps.fetch(
      `${credentials.apiUrl}/v1/${credentials.org}/${credentials.workspace}/tacho/enrollments/revoke`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hostEnrollmentId: host.host_enrollment_id,
          reason: options.reason ?? "tacho unenroll",
        }),
      },
    );
    if (response.ok) return true;
    warnings.push(
      `revoke answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  } catch (error) {
    warnings.push(
      `revoke failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return false;
}

/**
 * Revoke on the control plane (a retry when host.json is already marked)
 * and record the enrollment as retired locally, so a later `enroll` takes
 * the fresh path instead of re-applying this enrollment's hooks. Returns
 * whether the control plane confirmed.
 */
export async function revokeAndMark(
  host: HostFile,
  options: CredentialOptions & { reason?: string },
  deps: CliDeps,
  warnings: string[],
): Promise<boolean> {
  const revoked = await revokeOnControlPlane(host, options, deps, warnings);
  if (host.revoked_at === null) {
    writeHostFile(deps.paths.hostFile, {
      ...host,
      revoked_at: toProtocolTimestamp(deps.now()),
    });
  }
  return revoked;
}

/**
 * Remove one enrollment's hook entries from every harness file, keeping
 * every foreign entry. Codex, Cursor and Stella are stripped whether or not
 * host.json lists them: a host.json lost mid-way must not leave hooks
 * behind. Both of Stella's files are stripped, because a `stella.toml`
 * created after enrollment makes Stella ignore the `settings.json` Tacho
 * wrote to, without removing the hooks from it.
 */
/** The harnesses the model base URL contract covers, off the route table. */
export const MODEL_BASE_URL_HARNESSES: ModelBaseUrlHarness[] = [
  ...MODEL_ROUTED_HARNESSES,
];

/**
 * Restore enrolled harnesses and any harness with a model URL receipt, which
 * can survive a reassign. With missing or invalid metadata, sweep every
 * supported harness so a lost host.json cannot
 * leave an agent pointing at a stopped gateway.
 */
export async function restoreModelBaseUrlsFor(
  host: Pick<HostFile, "port" | "harnesses"> | undefined,
  deps: CliDeps,
): Promise<{ restored: string[]; failed: string[] }> {
  const restored: string[] = [];
  const failed: string[] = [];
  if (deps.modelBaseUrls === undefined) return { restored, failed };
  const stellaHome = dirname(deps.paths.stellaToml);
  for (const harness of MODEL_BASE_URL_HARNESSES) {
    try {
      if (host !== undefined && !host.harnesses.includes(harness)) {
        try {
          lstatSync(modelBaseUrlBackupPath(harness, deps.home, stellaHome));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (!hasOrphanedModelBaseUrl(harness, deps.home, stellaHome))
            continue;
        }
      }
      const state = await deps.modelBaseUrls.restore({
        home: deps.home,
        stellaHome,
        // Restore recognises the proxy's URL on any port; the port only
        // labels the report.
        port: host !== undefined ? modelProxyPortFor(host) : 1024,
        harnesses: [harness],
      });
      for (const entry of state.harnesses)
        if (entry.changed) restored.push(entry.file);
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { restored, failed };
}

export function stripEnrollmentHooks(
  host:
    | Pick<
        HostFile,
        "host_enrollment_id" | "displaced_env" | "displaced_mcp_servers"
      >
    | undefined,
  deps: CliDeps,
  /**
   * Also give the files back (`settleHarnessFiles`). Only `unenroll` does:
   * `reassign` and a re-enroll strip and then merge again, and settling in
   * between would drop the receipt of the user's original while the file
   * still carries other Oxagen values, so the final unenroll could no longer
   * restore it byte for byte.
   */
  settle = false,
): {
  settingsChanged: boolean;
  codexChanged: boolean;
  /** The Cursor hooks files Tacho's entries were removed from. */
  cursorChanged: string[];
  /** The Stella files Tacho's hooks were removed from. */
  stellaChanged: string[];
  /** Claude Desktop's config, when our MCP server entry was removed from it. */
  claudeDesktopChanged?: string;
  /**
   * Files that could not be cleaned, each with why. One unreadable file (JSON
   * the user has since broken, a file locked read-only) used to throw out of
   * here and take the whole unenroll with it, before the service was stopped
   * or anything was revoked; now the others are still cleaned and this one is
   * named. It is never rewritten: a file Tacho cannot parse is left exactly
   * as it is.
   */
  failed: string[];
} {
  const failed: string[] = [];
  const attempt = (path: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push(reason.includes(path) ? reason : `${path}: ${reason}`);
    }
  };
  let settingsChanged = false;
  attempt(deps.paths.claudeSettings, () => {
    const stripped = stripTachoSettings(
      deps.readSettings(),
      host?.host_enrollment_id,
      host?.displaced_env ?? {},
    );
    if (stripped.changed) {
      deps.writeSettings(stripped.settings);
      settingsChanged = true;
    }
  });
  const cursorChanged: string[] = [];
  for (const path of deps.paths.cursorHooks) {
    attempt(path, () => {
      const current = deps.readCursorHooks(path);
      if (current === undefined) return;
      const stripped = stripCursorHooks(current, host?.host_enrollment_id);
      if (stripped.changed) {
        // The strip leaves Cursor's `version` standing, because this document
        // reads the same whether we created it or the user brought it. Saying
        // here that nothing but that scaffolding remains is what lets
        // `settle` take back a file Tacho made, while a hook the user added
        // while enrolled keeps the file instead.
        deps.writeCursorHooks(
          path,
          stripped.document,
          cursorDocumentIsVestigial(stripped.document),
        );
        cursorChanged.push(path);
      }
    });
  }
  let codexChanged = false;
  attempt(deps.paths.codexHooks, () => {
    const codexCurrent = deps.readCodexHooks();
    if (codexCurrent === undefined) return;
    const codexStripped = stripCodexHooks(
      codexCurrent,
      host?.host_enrollment_id,
    );
    if (codexStripped.changed) {
      deps.writeCodexHooks(codexStripped.settings);
      codexChanged = true;
    }
  });
  const stellaChanged: string[] = [];
  for (const format of ["toml", "json"] as const) {
    attempt(
      format === "toml" ? deps.paths.stellaToml : deps.paths.stellaSettingsJson,
      () => {
        const file = deps.readStellaHooks(format);
        if (file.text === undefined) return;
        const stellaStripped = stripStellaHooks(file, host?.host_enrollment_id);
        if (stellaStripped.changed) {
          deps.writeStellaHooks(stellaStripped.file);
          stellaChanged.push(file.path);
        }
      },
    );
  }
  // The connected tier (ADR-078). Removes exactly the entry enroll wrote and
  // puts back whatever it displaced; every other MCP server the user has is
  // left alone, including one that took our key after we wrote ours.
  let claudeDesktopChanged: string | undefined;
  const desktopPath = deps.paths.claudeDesktopConfig;
  if (desktopPath !== undefined) {
    attempt(desktopPath, () => {
      const current = deps.readClaudeDesktopConfig();
      if (current === undefined) return;
      const desktopStripped = stripClaudeDesktopConfig(
        current,
        host?.host_enrollment_id,
        (host?.displaced_mcp_servers?.["claude-desktop"] ?? {}) as Record<
          string,
          McpServerEntry
        >,
      );
      if (desktopStripped.changed) {
        deps.writeClaudeDesktopConfig(desktopStripped.config);
        claudeDesktopChanged = desktopPath;
      }
    });
  }
  // The pure strips above leave a correct document; this gives the *file*
  // back: the user's own bytes, mode and symlink, and nothing where enroll
  // had to create something (`host/harness-file.ts`). Skipped while any file
  // failed, so its receipt and its backup survive for the retry.
  if (settle && failed.length === 0) {
    try {
      deps.settleHarnessFiles?.();
    } catch (error) {
      failed.push(
        `restoring the original files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    settingsChanged,
    codexChanged,
    cursorChanged,
    stellaChanged,
    claudeDesktopChanged,
    failed,
  };
}

/**
 * `unenroll` under the install lock (`host/install-lock.ts`): a second
 * installer running at the same time is refused, not interleaved.
 */
export async function unenroll(
  options: UnenrollOptions,
  deps: CliDeps,
): Promise<UnenrollResult> {
  const lock = acquireInstallLock(deps.paths.root, deps.now);
  if ("heldBy" in lock) {
    const warning = `another tacho enroll, unenroll or reassign is running on this machine (pid ${lock.heldBy}); wait for it to finish and run this again`;
    deps.err(`warning: ${warning}`);
    return {
      ok: false,
      settingsChanged: false,
      revoked: false,
      warnings: [warning],
    };
  }
  try {
    return await unenrollLocked(options, deps);
  } finally {
    lock.release();
    // Nothing of ours left in it: the directory goes too, so a machine that
    // was enrolled and purged looks like one that never was.
    removeIfEmpty(deps.paths.root);
  }
}

/** Remove a directory that holds nothing; leave one that does. */
function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Not there, or not empty by the time we looked.
  }
}

async function unenrollLocked(
  options: UnenrollOptions,
  deps: CliDeps,
): Promise<UnenrollResult> {
  const warnings: string[] = [];
  let incomplete = false;
  // Never a throw: a host.json that is truncated, hand-edited or written by
  // another version must not be what stops a machine being uninstalled. What
  // can be salvaged (the enrollment id, the displaced values) still steers
  // the strip; the file itself is kept for a person to look at.
  const read = readHostFileLenient(deps.paths.hostFile);
  const host = read.host;
  if (read.error !== undefined) {
    warnings.push(
      `${read.error}; removing the hooks and the service anyway. The enrollment cannot be revoked from here: revoke it from the fleet page.`,
    );
    incomplete = true;
  }

  const githubFailures = read.githubRecoveryError
    ? [read.githubRecoveryError]
    : restoreGithubRepositories(host ?? read.salvaged, deps);
  if (githubFailures.length > 0) {
    warnings.push(...githubFailures);
    for (const warning of warnings) deps.err(`warning: ${warning}`);
    return { ok: false, settingsChanged: false, revoked: false, warnings };
  }

  // First of all: each harness gets its vendor key back from custody and
  // its run token or helper taken out (ADR-143), before the base URL goes
  // and long before the daemon stops. A harness left with a run token and
  // no gateway has no credential at all.
  const credentials = await restoreCredentials(host, deps, "unenroll");
  for (const file of credentials.restored)
    deps.out(`      model credential given back to ${file}`);
  warnings.push(...credentials.warnings);
  for (const failure of credentials.failed) {
    incomplete = true;
    warnings.push(
      `could not give a model credential back: ${failure}. The gateway remains installed so the agent can still make model calls. Fix the file and run \`tacho unenroll\` again`,
    );
  }
  if (credentials.failed.length > 0) {
    warnings.push(
      "Unenrollment stopped before removing the base URL, hooks, service, or credentials. Fix the named config files, then retry.",
    );
    for (const warning of warnings) deps.err(`warning: ${warning}`);
    return { ok: false, settingsChanged: false, revoked: false, warnings };
  }

  // Then, and before the daemon is stopped below: a base URL that names a
  // port nothing listens on stops the agent making any model call.
  const baseUrls = await restoreModelBaseUrlsFor(host, deps);
  for (const file of baseUrls.restored)
    deps.out(`      model base URL taken out of ${file}`);
  for (const failure of baseUrls.failed) {
    incomplete = true;
    warnings.push(
      `could not take the model base URL out: ${failure}. The gateway remains installed so the agent can still make model calls. Remove the base URL by hand, or fix the file and run \`tacho unenroll\` again`,
    );
  }

  if (baseUrls.failed.length > 0) {
    warnings.push(
      "Unenrollment stopped before removing hooks, service, or credentials. Fix the named config files, then retry.",
    );
    for (const warning of warnings) deps.err(`warning: ${warning}`);
    return { ok: false, settingsChanged: false, revoked: false, warnings };
  }

  deps.out(`[1/4] Removing Tacho hooks from ${deps.paths.claudeSettings}`);
  // Not settled while a base URL is still in a file: the receipt is what the
  // retry needs to put the original back.
  const stripped = stripEnrollmentHooks(
    host ?? read.salvaged,
    deps,
    baseUrls.failed.length === 0,
  );
  if (stripped.settingsChanged) {
    deps.out("      removed; every non-Tacho entry kept");
  } else {
    deps.out("      nothing to remove");
  }
  if (stripped.codexChanged) {
    deps.out(`      removed from ${deps.paths.codexHooks} too`);
  }
  for (const path of stripped.cursorChanged) {
    deps.out(`      removed from ${path} too`);
  }
  for (const path of stripped.stellaChanged) {
    deps.out(`      removed from ${path} too`);
  }
  if (stripped.claudeDesktopChanged !== undefined) {
    deps.out(`      removed from ${stripped.claudeDesktopChanged} too`);
    deps.out(
      "      Quit Claude Desktop and open it again for the change to take effect",
    );
  }
  for (const failure of stripped.failed) {
    incomplete = true;
    warnings.push(
      `could not clean ${failure}. The file was left exactly as it is; fix it and run \`tacho unenroll\` again to finish`,
    );
  }

  deps.out(`[2/4] Stopping the ${deps.serviceManager.kind} service`);
  try {
    deps.serviceManager.uninstall();
  } catch (error) {
    incomplete = true;
    warnings.push(
      `service removal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    for (const warning of warnings) deps.err(`warning: ${warning}`);
    return {
      ok: false,
      settingsChanged: stripped.settingsChanged,
      revoked: false,
      warnings,
    };
  }

  let revoked = false;
  if (host === undefined) {
    deps.out("[3/4] No enrollment on this machine; nothing to revoke");
  } else {
    // A host.json already marked retired is one whose revoke did not go
    // through last time (a fleet-page revoke reaches the host as
    // host_status, never as revoked_at): ask the control plane again. The
    // handler is idempotent, so a revoke that did land costs one request.
    deps.out(
      host.revoked_at !== null
        ? `[3/4] Finishing the revoke of ${host.host_enrollment_id} pending since ${host.revoked_at}`
        : `[3/4] Revoking ${host.host_enrollment_id} on ${host.api_url}`,
    );
    revoked = await revokeAndMark(
      host,
      { ...options, reason: options.reason ?? "tacho unenroll" },
      deps,
      warnings,
    );
    if (revoked) deps.out("      revoked");
  }

  deps.out(`[4/4] Removing host credentials under ${deps.paths.root}`);
  // Custody is over: every key went back to its file above, so the store and
  // its key are shredded, and the run token signing key goes with them so a
  // token still in some process's memory is refused from here on. A store
  // that could not be opened is the one exception: it is left where it is,
  // since shredding it would end the one chance a repaired key file gives.
  if (!credentials.custodyUnreadable) {
    try {
      deps.credentialStore?.shred();
    } catch (error) {
      warnings.push(
        `could not shred the credential store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const path of [
    deps.paths.runTokenKey,
    deps.paths.deviceKey,
    deps.paths.socket,
    deps.paths.daemonState,
    deps.paths.transcriptTailState,
    deps.paths.pid,
    deps.paths.daemonLauncher,
  ]) {
    if (existsSync(path)) unlinkSync(path);
  }
  // A harness file that could not be cleaned still needs the enrollment id
  // and the displaced values to be cleaned later, so host.json outlives it.
  if (
    (revoked || host === undefined) &&
    read.error === undefined &&
    stripped.failed.length === 0
  ) {
    if (existsSync(deps.paths.hostFile)) unlinkSync(deps.paths.hostFile);
  } else if (host !== undefined && !revoked) {
    deps.out(
      "      host.json kept (marked retired locally) so a later `tacho unenroll` can finish the server-side revoke",
    );
  } else {
    deps.out("      host.json kept so a later `tacho unenroll` can finish");
  }
  if (options.purge === true) {
    for (const dir of [
      deps.paths.wal,
      deps.paths.spool,
      deps.paths.quarantine,
    ]) {
      rmSync(dir, { recursive: true, force: true });
    }
    // The log is part of the local record: a purge that kept it left the
    // one file most likely to name a repository path or a prompt. The
    // pending session ends hold sealed terminal batches, bodies included,
    // that never reached the WAL, so they go with it (ADR-139).
    rmSync(deps.paths.log, { force: true });
    rmSync(deps.paths.pendingEnds, { force: true });
    deps.out(
      "      WAL, spool, quarantine, pending session ends and the collector log purged",
    );
  } else {
    deps.out(`      WAL kept at ${deps.paths.wal} (pass --purge to delete)`);
  }
  for (const warning of warnings) deps.err(`warning: ${warning}`);
  return {
    ok: !incomplete,
    settingsChanged: stripped.settingsChanged,
    revoked,
    warnings,
  };
}
