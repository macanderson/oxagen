/**
 * `tacho status`: enrollment identity, daemon health, hook presence per
 * event, bundle version and age, last ingest, spool depth, unobserved
 * sessions since boot (spec section 5.1).
 */
import { readHostFile } from "../host/host-file";
import { tachoHookPresence } from "../host/settings-writer";
import { Wal } from "../host/wal";
import type { CliDeps } from "./deps";

export interface StatusOptions {
  json?: boolean;
}

export interface StatusReport {
  enrolled: boolean;
  host?: {
    host_enrollment_id: string;
    agent_key: string;
    organization_id: string;
    workspace_id: string;
    host_status: string;
    mode: string;
    managed: boolean;
    enrolled_at: string;
    expires_at: string;
    revoked_at: string | null;
    port: number;
    claude_version: string | null;
    wrapper_version: string;
  };
  bundle?: {
    version: number;
    etag: string;
    fetched_at: string;
    age_s: number;
    expires_at: string;
  };
  service?: {
    kind: string;
    installed: boolean;
    running: boolean;
    detail?: string;
  };
  daemon?: Record<string, unknown> | null;
  hooks?: ReturnType<typeof tachoHookPresence>;
  wal?: { sessions: number; unshipped: number; oldest_unshipped_at?: string };
}

export async function status(
  options: StatusOptions,
  deps: CliDeps,
): Promise<StatusReport> {
  const host = readHostFile(deps.paths.hostFile);
  if (host === undefined) {
    const report: StatusReport = { enrolled: false };
    if (options.json === true) deps.out(JSON.stringify(report, null, 2));
    else
      deps.out(
        `Not enrolled (no ${deps.paths.hostFile}). Run \`tacho enroll\`.`,
      );
    return report;
  }
  const service = deps.serviceManager.status();
  const daemon =
    ((await deps.daemonGet("/status")) as
      | Record<string, unknown>
      | undefined) ?? null;
  const hooks = tachoHookPresence(deps.readSettings(), host.host_enrollment_id);
  const walStats = new Wal(deps.paths.wal).stats();
  const report: StatusReport = {
    enrolled: true,
    host: {
      host_enrollment_id: host.host_enrollment_id,
      agent_key: host.agent_key,
      organization_id: host.organization_id,
      workspace_id: host.workspace_id,
      host_status: host.host_status,
      mode: host.bundle.mode,
      managed: host.managed,
      enrolled_at: host.enrolled_at,
      expires_at: host.expires_at,
      revoked_at: host.revoked_at,
      port: host.port,
      claude_version: host.claude_version,
      wrapper_version: host.wrapper_version,
    },
    bundle: {
      version: host.bundle.version,
      etag: host.bundle.etag,
      fetched_at: host.bundle_fetched_at,
      age_s: Math.max(
        0,
        Math.floor((deps.now() - Date.parse(host.bundle_fetched_at)) / 1000),
      ),
      expires_at: host.bundle.expires_at,
    },
    service: { kind: deps.serviceManager.kind, ...service },
    daemon,
    hooks,
    wal: {
      sessions: walStats.sessions,
      unshipped: walStats.unshipped,
      ...(walStats.oldestUnshippedAt !== undefined
        ? { oldest_unshipped_at: walStats.oldestUnshippedAt }
        : {}),
    },
  };
  if (options.json === true) {
    deps.out(JSON.stringify(report, null, 2));
    return report;
  }
  const h = report.host as NonNullable<StatusReport["host"]>;
  const b = report.bundle as NonNullable<StatusReport["bundle"]>;
  deps.out(
    `Enrollment  ${h.agent_key} (${h.host_enrollment_id}) in ${h.organization_id}/${h.workspace_id}`,
  );
  deps.out(
    `Status      ${h.host_status}${h.revoked_at !== null ? ` (revoked ${h.revoked_at})` : ""}, mode ${h.mode}${h.managed ? ", managed" : ""}, expires ${h.expires_at}`,
  );
  deps.out(
    `Bundle      v${b.version} (${b.etag}) fetched ${b.age_s}s ago, expires ${b.expires_at}`,
  );
  deps.out(
    `Service     ${deps.serviceManager.kind}: ${service.installed ? "installed" : "not installed"}, ${service.running ? "running" : "not running"}`,
  );
  if (daemon === null) {
    deps.out(`Daemon      not answering on 127.0.0.1:${h.port}`);
  } else {
    const d = daemon as {
      uptime_s?: number;
      spool_depth?: number;
      last_ingest_at?: string | null;
      last_error?: string | null;
      sessions?: unknown[];
      unobserved_sessions?: string[];
    };
    deps.out(
      `Daemon      up ${d.uptime_s ?? "?"}s, spool ${d.spool_depth ?? "?"}, last ingest ${d.last_ingest_at ?? "never"}${d.last_error ? `, last error: ${d.last_error}` : ""}`,
    );
    deps.out(
      `Sessions    ${Array.isArray(d.sessions) ? d.sessions.length : 0} known this boot, ${d.unobserved_sessions?.length ?? 0} unobserved`,
    );
  }
  deps.out(
    `Hooks       ${hooks.complete ? "complete" : "INCOMPLETE"}: ${hooks.present.length} present, ${hooks.missing.length} missing${hooks.disabledByFlag ? ", disableAllHooks is set" : ""}${hooks.envOk ? "" : ", env block missing"}`,
  );
  if (hooks.missing.length > 0)
    deps.out(`            missing: ${hooks.missing.join(", ")}`);
  deps.out(
    `WAL         ${walStats.sessions} session files, ${walStats.unshipped} events unshipped${walStats.oldestUnshippedAt !== undefined ? ` (oldest ${walStats.oldestUnshippedAt})` : ""}`,
  );
  return report;
}
