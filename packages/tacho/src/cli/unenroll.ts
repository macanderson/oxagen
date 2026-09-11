/**
 * `tacho unenroll` (spec section 5.1, acceptance 18): strip Tacho's hook
 * entries and env keys (every foreign entry survives), stop and remove the
 * service, revoke the enrollment on the control plane, and delete the host
 * key and credentials. The WAL stays for inspection unless `--purge`.
 */
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { readHostFile, writeHostFile } from "../host/host-file";
import { stripTachoSettings } from "../host/settings-writer";
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

export async function unenroll(
  options: UnenrollOptions,
  deps: CliDeps,
): Promise<UnenrollResult> {
  const warnings: string[] = [];
  const host = readHostFile(deps.paths.hostFile);

  deps.out(`[1/4] Removing Tacho hooks from ${deps.paths.claudeSettings}`);
  const current = deps.readSettings();
  const stripped = stripTachoSettings(
    current,
    host?.host_enrollment_id,
    host?.displaced_env ?? {},
  );
  if (stripped.changed) {
    deps.writeSettings(stripped.settings);
    deps.out("      removed; every non-Tacho entry kept");
  } else {
    deps.out("      nothing to remove");
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
  } else if (host.revoked_at !== null) {
    deps.out(`[3/4] Enrollment already revoked at ${host.revoked_at}`);
    revoked = true;
  } else {
    deps.out(`[3/4] Revoking ${host.host_enrollment_id} on ${host.api_url}`);
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
    } else {
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
        if (response.ok) {
          revoked = true;
          deps.out("      revoked");
        } else {
          warnings.push(
            `revoke answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
          );
        }
      } catch (error) {
        warnings.push(
          `revoke failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!revoked) {
      writeHostFile(deps.paths.hostFile, {
        ...host,
        revoked_at: toProtocolTimestamp(deps.now()),
      });
    }
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
      "      host.json kept (marked revoked locally) so a later `tacho unenroll` can finish the server-side revoke",
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
  return { ok: true, settingsChanged: stripped.changed, revoked, warnings };
}
