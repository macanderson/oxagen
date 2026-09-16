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
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { stripClaudeDesktopConfig } from "../host/claude-desktop-writer";
import { stripCodexHooks } from "../host/codex-writer";
import type { McpServerEntry } from "../host/mcp-config-writer";
import { type HostFile, readHostFile, writeHostFile } from "../host/host-file";
import { stripTachoSettings } from "../host/settings-writer";
import { stripStellaHooks } from "../host/stella-writer";
import { toProtocolTimestamp } from "../timestamp";
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
 * every foreign entry. Codex and Stella are stripped whether or not
 * host.json lists them: a host.json lost mid-way must not leave hooks
 * behind. Both of Stella's files are stripped, because a `stella.toml`
 * created after enrollment makes Stella ignore the `settings.json` Tacho
 * wrote to, without removing the hooks from it.
 */
export function stripEnrollmentHooks(
  host:
    | Pick<
        HostFile,
        "host_enrollment_id" | "displaced_env" | "displaced_mcp_servers"
      >
    | undefined,
  deps: CliDeps,
): {
  settingsChanged: boolean;
  codexChanged: boolean;
  /** The Stella files Tacho's hooks were removed from. */
  stellaChanged: string[];
  /** Claude Desktop's config, when our MCP server entry was removed from it. */
  claudeDesktopChanged?: string;
} {
  const stripped = stripTachoSettings(
    deps.readSettings(),
    host?.host_enrollment_id,
    host?.displaced_env ?? {},
  );
  if (stripped.changed) deps.writeSettings(stripped.settings);
  let codexChanged = false;
  const codexCurrent = deps.readCodexHooks();
  if (codexCurrent !== undefined) {
    const codexStripped = stripCodexHooks(
      codexCurrent,
      host?.host_enrollment_id,
    );
    if (codexStripped.changed) {
      deps.writeCodexHooks(codexStripped.settings);
      codexChanged = true;
    }
  }
  const stellaChanged: string[] = [];
  for (const format of ["toml", "json"] as const) {
    const file = deps.readStellaHooks(format);
    if (file.text === undefined) continue;
    const stellaStripped = stripStellaHooks(file, host?.host_enrollment_id);
    if (stellaStripped.changed) {
      deps.writeStellaHooks(stellaStripped.file);
      stellaChanged.push(file.path);
    }
  }
  // The connected tier (ADR-069). Removes exactly the entry enroll wrote and
  // puts back whatever it displaced; every other MCP server the user has is
  // left alone, including one that took our key after we wrote ours.
  let claudeDesktopChanged: string | undefined;
  const desktopPath = deps.paths.claudeDesktopConfig;
  if (desktopPath !== undefined) {
    const current = deps.readClaudeDesktopConfig();
    if (current !== undefined) {
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
    }
  }
  return {
    settingsChanged: stripped.changed,
    codexChanged,
    stellaChanged,
    claudeDesktopChanged,
  };
}

export async function unenroll(
  options: UnenrollOptions,
  deps: CliDeps,
): Promise<UnenrollResult> {
  const warnings: string[] = [];
  const host = readHostFile(deps.paths.hostFile);

  deps.out(`[1/4] Removing Tacho hooks from ${deps.paths.claudeSettings}`);
  const stripped = stripEnrollmentHooks(host, deps);
  if (stripped.settingsChanged) {
    deps.out("      removed; every non-Tacho entry kept");
  } else {
    deps.out("      nothing to remove");
  }
  if (stripped.codexChanged) {
    deps.out(`      removed from ${deps.paths.codexHooks} too`);
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

  deps.out(`[2/4] Stopping the ${deps.serviceManager.kind} service`);
  try {
    deps.serviceManager.uninstall();
  } catch (error) {
    warnings.push(
      `service removal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  for (const path of [
    deps.paths.deviceKey,
    deps.paths.socket,
    deps.paths.daemonState,
    deps.paths.pid,
  ]) {
    if (existsSync(path)) unlinkSync(path);
  }
  if (revoked || host === undefined) {
    if (existsSync(deps.paths.hostFile)) unlinkSync(deps.paths.hostFile);
  } else {
    deps.out(
      "      host.json kept (marked retired locally) so a later `tacho unenroll` can finish the server-side revoke",
    );
  }
  if (options.purge === true) {
    for (const dir of [
      deps.paths.wal,
      deps.paths.spool,
      deps.paths.quarantine,
    ]) {
      rmSync(dir, { recursive: true, force: true });
    }
    deps.out("      WAL, spool, and quarantine purged");
  } else {
    deps.out(`      WAL kept at ${deps.paths.wal} (pass --purge to delete)`);
  }
  for (const warning of warnings) deps.err(`warning: ${warning}`);
  return {
    ok: true,
    settingsChanged: stripped.settingsChanged,
    revoked,
    warnings,
  };
}
