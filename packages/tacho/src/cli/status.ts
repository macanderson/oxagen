/**
 * `tacho status`: enrollment identity, daemon health, hook presence per
 * event, bundle version and age, last ingest, spool depth, unobserved
 * sessions since boot (spec section 5.1).
 */
import { claudeDesktopPresence } from "../host/claude-desktop-writer";
import { codexHookPresence } from "../host/codex-writer";
import { readHostFileLenient } from "../host/host-file";
import { tachoHookPresence } from "../host/settings-writer";
import { stellaHookPresence } from "../host/stella-writer";
import { Wal } from "../host/wal";
import type { CliDeps } from "./deps";

export interface StatusOptions {
  json?: boolean;
}

export interface StatusReport {
  enrolled: boolean;
  /**
   * host.json is marked `revoked_at`: unenrolled on this machine, with the
   * server-side revoke still to finish. `enrolled` is false.
   */
  retired?: boolean;
  /** Files that could not be read, each with why. */
  problems?: string[];
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
    codex_version: string | null;
    stella_version: string | null;
    wrapper_version: string;
    /** The slugs the desktop app shows and reassigns against. */
    org_slug: string;
    workspace_slug: string;
    harnesses: string[];
    platform: string;
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
  /** Present when the host enrolled Codex. */
  codexHooks?: ReturnType<typeof codexHookPresence>;
  /** Present when the host enrolled Stella. */
  stellaHooks?: ReturnType<typeof stellaHookPresence>;
  /**
   * Present when the host connected Claude Desktop. Not called `hooks`,
   * because there are none: a connected app carries an MCP server entry, and
   * `otherServers` is the count of servers in that app Oxagen does not see
   * (ADR-078 §3).
   */
  claudeDesktop?: ReturnType<typeof claudeDesktopPresence>;
  wal?: { sessions: number; unshipped: number; oldest_unshipped_at?: string };
}

export async function status(
  options: StatusOptions,
  deps: CliDeps,
): Promise<StatusReport> {
  // Lenient: `status` is what a person runs when something is wrong, so a
  // host.json that does not validate is a finding to print, not a throw.
  const read = readHostFileLenient(deps.paths.hostFile);
  const host = read.host;
  if (host === undefined) {
    const report: StatusReport = {
      enrolled: false,
      ...(read.error !== undefined ? { problems: [read.error] } : {}),
    };
    if (options.json === true) deps.out(JSON.stringify(report, null, 2));
    else
      deps.out(
        read.error !== undefined
          ? `Not enrolled: ${read.error}. Run \`tacho unenroll\` to clear it, then \`tacho enroll\`.`
          : `Not enrolled (no ${deps.paths.hostFile}). Run \`tacho enroll\`.`,
      );
    return report;
  }
  // Each harness file is read on its own: one the user has broken is named
  // under `problems`, and the rest of the report still comes out as JSON the
  // desktop app can parse.
  const problems: string[] = [];
  const guarded = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  const service = deps.serviceManager.status();
  const daemon =
    ((await deps.daemonGet("/status")) as
      | Record<string, unknown>
      | undefined) ?? null;
  const hooks = tachoHookPresence(
    guarded(deps.readSettings),
    host.host_enrollment_id,
  );
  const codexHooks = host.harnesses.includes("codex")
    ? codexHookPresence(guarded(deps.readCodexHooks), host.host_enrollment_id)
    : undefined;
  const stellaHooks = host.harnesses.includes("stella")
    ? guarded(() =>
        stellaHookPresence(deps.readStellaHooks(), host.host_enrollment_id),
      )
    : undefined;
  const claudeDesktop = host.harnesses.includes("claude-desktop")
    ? claudeDesktopPresence(
        guarded(deps.readClaudeDesktopConfig),
        host.host_enrollment_id,
      )
    : undefined;
  const walStats = new Wal(deps.paths.wal).stats();
  // `revoked_at` means unenrolled on this machine: the hooks and the service
  // are gone and only the server-side revoke is pending. Reporting that as
  // enrolled (exit 0) disagreed with `tacho detect` about the same file and
  // kept the desktop app on its "enrolled" screens for a host that was not.
  const retired = host.revoked_at !== null;
  const report: StatusReport = {
    enrolled: !retired,
    ...(retired ? { retired: true } : {}),
    ...(problems.length > 0 ? { problems } : {}),
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
      codex_version: host.codex_version ?? null,
      stella_version: host.stella_version ?? null,
      wrapper_version: host.wrapper_version,
      org_slug: host.org_slug,
      workspace_slug: host.workspace_slug,
      harnesses: host.harnesses,
      platform: host.platform,
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
    ...(codexHooks !== undefined ? { codexHooks } : {}),
    ...(stellaHooks !== undefined ? { stellaHooks } : {}),
    ...(claudeDesktop !== undefined ? { claudeDesktop } : {}),
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
  if (retired)
    deps.out(
      `Not enrolled. ${h.host_enrollment_id} was unenrolled here on ${h.revoked_at ?? ""}. The server-side revoke is still pending: run \`tacho unenroll\` again while signed in, or revoke it from the fleet page.`,
    );
  for (const problem of problems) deps.out(`Unreadable  ${problem}`);
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
  // Only for a host that hooks Claude Code: a Codex-only host used to read
  // "Hooks INCOMPLETE: 0 present, 33 missing" about a harness it never asked for.
  if (host.harnesses.includes("claude-code")) {
    deps.out(
      `Hooks       ${hooks.complete ? "complete" : "INCOMPLETE"}: ${hooks.present.length} present, ${hooks.missing.length} missing${hooks.disabledByFlag ? ", disableAllHooks is set" : ""}${hooks.envOk ? "" : ", env block missing"}`,
    );
    if (hooks.missing.length > 0)
      deps.out(`            missing: ${hooks.missing.join(", ")}`);
  }
  if (claudeDesktop !== undefined) {
    deps.out(
      `Claude Desktop ${claudeDesktop.present ? "connected" : "NOT CONNECTED"}: serves the workspace toolbelt through the local gateway; records the Oxagen tools it calls, not what else the app does`,
    );
    if (claudeDesktop.foreignEnrollment)
      deps.out(
        "            an entry from an earlier enrollment is still there; reconnect the app",
      );
    if (claudeDesktop.otherServers > 0)
      deps.out(
        `            ${claudeDesktop.otherServers} other MCP server(s): ${claudeDesktop.otherServerNames.join(", ")} — Oxagen does not see what they serve`,
      );
  }
  if (codexHooks !== undefined) {
    deps.out(
      `Codex       ${codexHooks.complete ? "complete" : "INCOMPLETE"}: ${codexHooks.present.length} present, ${codexHooks.missing.length} missing`,
    );
    if (codexHooks.missing.length > 0)
      deps.out(`            missing: ${codexHooks.missing.join(", ")}`);
  }
  if (stellaHooks !== undefined) {
    deps.out(
      `Stella      ${stellaHooks.complete ? "complete" : "INCOMPLETE"}: ${stellaHooks.present.length} present, ${stellaHooks.missing.length} missing`,
    );
    if (stellaHooks.missing.length > 0)
      deps.out(`            missing: ${stellaHooks.missing.join(", ")}`);
  }
  deps.out(
    `WAL         ${walStats.sessions} session files, ${walStats.unshipped} events unshipped${walStats.oldestUnshippedAt !== undefined ? ` (oldest ${walStats.oldestUnshippedAt})` : ""}`,
  );
  return report;
}
