/**
 * `tacho reassign --workspace <slug>`: point an enrolled host at another
 * workspace (or org) in one step. The host API key is minted for the
 * workspace at enrollment, so a move is a revoke plus a fresh enrollment;
 * what carries over is the device key, the loopback port, and the local
 * token, so the control plane sees one continuous host identity and the
 * hook entries only change their enrollment id.
 */
import { stripCodexHooks } from "../host/codex-writer";
import { readHostFile } from "../host/host-file";
import { stripTachoSettings } from "../host/settings-writer";
import type { TachoHarness } from "../wire";
import type { CliDeps, CredentialOptions } from "./deps";
import { enroll } from "./enroll";
import { revokeOnControlPlane } from "./unenroll";

export interface ReassignOptions extends CredentialOptions {
  /** Keep the current harness list (default) or replace it. */
  harnesses?: TachoHarness[];
  reason?: string;
}

export interface ReassignResult {
  ok: boolean;
  from?: { org: string; workspace: string; enrollmentId: string };
  to?: { org: string; workspace: string; enrollmentId: string };
  warnings: string[];
}

export async function reassign(
  options: ReassignOptions,
  deps: CliDeps,
): Promise<ReassignResult> {
  const warnings: string[] = [];
  const host = readHostFile(deps.paths.hostFile);
  if (host === undefined) {
    deps.err(
      `Not enrolled (no ${deps.paths.hostFile}); run \`tacho enroll --workspace <slug>\` instead.`,
    );
    return { ok: false, warnings };
  }
  const org = options.org ?? host.org_slug;
  // `--harness` alone re-enrolls in place, which is how a harness is removed
  // (`enroll` never drops one).
  const workspace = options.workspace ?? host.workspace_slug;
  if (options.workspace === undefined && options.harnesses === undefined) {
    deps.err(
      "reassign needs --workspace <slug> (and --org <slug> to change org) or --harness <list>",
    );
    return { ok: false, warnings };
  }
  const sameHarnesses =
    options.harnesses === undefined ||
    [...options.harnesses].sort().join(",") ===
      [...host.harnesses].sort().join(",");
  if (
    org === host.org_slug &&
    workspace === host.workspace_slug &&
    sameHarnesses
  ) {
    deps.out(
      `Already reporting to ${org}/${workspace} as ${host.agent_key}; nothing to do.`,
    );
    return {
      ok: true,
      from: {
        org,
        workspace,
        enrollmentId: host.host_enrollment_id,
      },
      to: { org, workspace, enrollmentId: host.host_enrollment_id },
      warnings,
    };
  }
  const from = {
    org: host.org_slug,
    workspace: host.workspace_slug,
    enrollmentId: host.host_enrollment_id,
  };

  deps.out(
    `[1/3] Revoking ${host.host_enrollment_id} in ${from.org}/${from.workspace}`,
  );
  if (host.revoked_at === null) {
    const revoked = await revokeOnControlPlane(
      host,
      {
        ...(options.token !== undefined ? { token: options.token } : {}),
        reason: options.reason ?? `tacho reassign to ${org}/${workspace}`,
      },
      deps,
      warnings,
    );
    deps.out(
      revoked
        ? "      revoked"
        : "      not revoked server-side; an operator can finish it from the fleet page",
    );
  } else {
    deps.out(`      already revoked at ${host.revoked_at}`);
  }

  deps.out("[2/3] Removing the old enrollment's hooks");
  const stripped = stripTachoSettings(
    deps.readSettings(),
    host.host_enrollment_id,
    host.displaced_env,
  );
  if (stripped.changed) deps.writeSettings(stripped.settings);
  const codexCurrent = deps.readCodexHooks();
  if (codexCurrent !== undefined) {
    const codexStripped = stripCodexHooks(
      codexCurrent,
      host.host_enrollment_id,
    );
    if (codexStripped.changed) deps.writeCodexHooks(codexStripped.settings);
  }

  deps.out(`[3/3] Enrolling in ${org}/${workspace}`);
  const result = await enroll(
    {
      ...(options.token !== undefined ? { token: options.token } : {}),
      org,
      workspace,
      // Stay on the API the host already talks to unless told otherwise.
      apiUrl: options.apiUrl ?? host.api_url,
      port: host.port,
      harnesses: options.harnesses ?? (host.harnesses as TachoHarness[]),
      managed: host.managed,
      force: true,
    },
    deps,
  );
  warnings.push(...result.warnings);
  if (!result.ok || result.host === undefined) {
    deps.err(
      `Reassign failed after revoking the old enrollment; this host is now unenrolled. Run \`tacho enroll --org ${org} --workspace ${workspace}\` once the cause is fixed.`,
    );
    return { ok: false, from, warnings };
  }
  const to = {
    org,
    workspace,
    enrollmentId: result.host.host_enrollment_id,
  };
  deps.out(
    `Reassigned: ${result.host.agent_key} now reports to ${to.org}/${to.workspace} (${to.enrollmentId}), device key kept.`,
  );
  return { ok: true, from, to, warnings };
}
