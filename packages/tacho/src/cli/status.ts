/**
 * `tacho status`: enrollment identity, daemon health, hook presence per
 * event, bundle version and age, last ingest, spool depth, unobserved
 * sessions since boot (spec section 5.1).
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { claudeDesktopPresence } from "../host/claude-desktop-writer";
import { codexHookPresence } from "../host/codex-writer";
import { cursorHookPresence } from "../host/cursor-writer";
import { modelProxyPortFor, readHostFileLenient } from "../host/host-file";
import type { ModelBaseUrlHarnessState } from "../host/model-base-url";
import type { ModelCredentialHarnessState } from "../host/model-credential";
import { describeHarness } from "./credential";
import { tachoHookPresence } from "../host/settings-writer";
import { stellaHookPresence } from "../host/stella-writer";
import { Wal } from "../host/wal";
import { isBrokerableHarness, isModelRoutedHarness } from "../wire";
import { type CliDeps, cursorAppFacts } from "./deps";
import { CURSOR_COVERAGE_NOTE, wrappedCursor } from "./detect";

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
  /**
   * The daemon's loopback model proxy, as the daemon reports it (ADR-094).
   * Absent when the daemon is not answering or predates the proxy.
   */
  gateway?: {
    listening: boolean;
    port: number;
    routes: string[];
    calls_observed: number;
  };
  /** Whether each harness's model base URL points at the proxy. */
  modelBaseUrls?: ModelBaseUrlHarnessState[];
  /**
   * How each routed harness gets its model credential (ADR-143): a run token
   * the gateway swaps for the key in its custody, or its own key. Absent
   * when no harness the gateway routes is enrolled.
   */
  modelCredentials?: ModelCredentialHarnessState[];
  /** Which providers are in the gateway's custody. Never a secret. */
  credentialCustody?: Array<{
    provider: string;
    kind: string;
    source: string;
    taken_at: string;
  }>;
  /**
   * The tier each harness's runs earned since the collector started, from
   * what was routed (ADR-095): `observe`, `harness` or `gateway`. A harness
   * with no run yet has no entry. A base URL in a file is intent, not a tier.
   */
  tiers?: Record<string, "observe" | "harness" | "gateway">;
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
    cursor_version: string | null;
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
    running: boolean | null;
    detail?: string;
  };
  daemon?: Record<string, unknown> | null;
  hooks?: ReturnType<typeof tachoHookPresence>;
  /** Present when the host enrolled Codex. */
  codexHooks?: ReturnType<typeof codexHookPresence>;
  /**
   * Present when the host enrolled Cursor: one entry per hooks file written,
   * because a moved config directory means there are two.
   */
  cursorHooks?: Array<{ path: string } & ReturnType<typeof cursorHookPresence>>;
  /**
   * Present when the host enrolled Cursor: which Cursor this machine has, by
   * the rule `tacho detect` applies (ADR-141). `cli` is the `cursor-agent`
   * alias enrollment recorded, still on disk; `app` is the editor on disk;
   * `null` is neither, and enrollment covers that machine all the same.
   */
  cursorInstall?: { foundVia: "cli" | "app" | null; path?: string };
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
  /**
   * Whether recorded events are reaching Oxagen. Absent for a host that is
   * not enrolled here. `tacho status` exits 1 when `healthy` is false.
   */
  shipping?: ShippingHealth;
}

/**
 * How long events may wait with nothing shipped before the host is called
 * stalled. The shipper drains on every tick, so ten minutes with an old event
 * waiting and no successful ingest is not a slow network.
 */
export const SHIPPING_STALL_MS = 10 * 60_000;

export interface ShippingHealth {
  healthy: boolean;
  /** One sentence a person can act on. */
  detail: string;
}

/**
 * The verdict on shipping, from the daemon's own report and the WAL. Before
 * this, a host could queue events for a day behind a failing ingest while
 * `tacho status` exited 0 and printed the error only as a trailing clause.
 */
export function shippingHealth(
  daemon: Record<string, unknown> | null,
  wal: { unshipped: number; oldestUnshippedAt?: string },
  now: number,
): ShippingHealth {
  if (daemon === null)
    return {
      healthy: false,
      detail:
        "the daemon is not answering, so nothing is recorded or shipped (restart the service, or run `tacho enroll` again)",
    };
  if (wal.unshipped === 0)
    return { healthy: true, detail: "every recorded event has shipped" };
  const lastError =
    typeof daemon["last_error"] === "string" && daemon["last_error"] !== ""
      ? daemon["last_error"]
      : undefined;
  const count = `${wal.unshipped} event${wal.unshipped === 1 ? "" : "s"} waiting`;
  if (lastError !== undefined)
    return {
      healthy: false,
      detail: `the last ingest failed, ${count}: ${lastError}`,
    };
  const lastIngest =
    typeof daemon["last_ingest_at"] === "string"
      ? Date.parse(daemon["last_ingest_at"])
      : Number.NaN;
  const oldest =
    wal.oldestUnshippedAt !== undefined
      ? Date.parse(wal.oldestUnshippedAt)
      : Number.NaN;
  const ingestStale =
    Number.isNaN(lastIngest) || now - lastIngest > SHIPPING_STALL_MS;
  const backlogOld = !Number.isNaN(oldest) && now - oldest > SHIPPING_STALL_MS;
  if (ingestStale && backlogOld)
    return {
      healthy: false,
      detail: `nothing has shipped in over ${SHIPPING_STALL_MS / 60_000} minutes, ${count}`,
    };
  return { healthy: true, detail: `shipping, ${count}` };
}

/**
 * Which Cursor this machine has, without the login-shell PATH lookup
 * `tacho detect` runs: the `cursor-agent` path enrollment recorded, when it
 * is still on disk, and the editor at the locations its platform documents.
 * The verdict comes from `wrappedCursor`, so status and detect apply one rule.
 */
function installedCursor(
  execpath: string | undefined,
  deps: CliDeps,
): NonNullable<StatusReport["cursorInstall"]> {
  const cli =
    execpath !== undefined && execpath.length > 0 && existsSync(execpath)
      ? execpath
      : undefined;
  const app =
    deps.cursorEditor?.() ?? cursorAppFacts(deps.platform, deps.home, deps.env);
  const found = wrappedCursor(
    { ...(cli !== undefined ? { path: cli } : {}), app },
    [],
  );
  return {
    foundVia: found.foundVia ?? null,
    ...(found.path !== undefined ? { path: found.path } : {}),
  };
}

const TIER_RANK = { observe: 0, harness: 1, gateway: 2 } as const;
type ObservedTier = keyof typeof TIER_RANK;

/** The daemon's `gateway` block, when it reports a well-formed one. */
export function gatewayOf(
  daemon: Record<string, unknown> | null,
): StatusReport["gateway"] {
  const raw = daemon?.["gateway"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const g = raw as Record<string, unknown>;
  if (typeof g["listening"] !== "boolean" || typeof g["port"] !== "number")
    return undefined;
  return {
    listening: g["listening"],
    port: g["port"],
    routes: Array.isArray(g["routes"])
      ? g["routes"].filter((r): r is string => typeof r === "string")
      : [],
    calls_observed:
      typeof g["calls_observed"] === "number" ? g["calls_observed"] : 0,
  };
}

/**
 * The highest tier each harness's sessions earned this boot, from the
 * daemon's own per-session `enforcement_tier`, which it computes from what
 * was routed. Nothing here is inferred from what is installed.
 */
export function observedTiers(
  daemon: Record<string, unknown> | null,
): Record<string, ObservedTier> {
  const out: Record<string, ObservedTier> = {};
  const sessions = daemon?.["sessions"];
  if (!Array.isArray(sessions)) return out;
  for (const session of sessions as Array<Record<string, unknown>>) {
    const harness = session["harness"];
    const tier = session["enforcement_tier"];
    if (typeof harness !== "string" || typeof tier !== "string") continue;
    if (!(tier in TIER_RANK)) continue;
    const current = out[harness];
    if (
      current === undefined ||
      TIER_RANK[tier as ObservedTier] > TIER_RANK[current]
    )
      out[harness] = tier as ObservedTier;
  }
  return out;
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
  const cursorHooks = host.harnesses.includes("cursor")
    ? deps.paths.cursorHooks.map((path) => ({
        path,
        ...cursorHookPresence(
          guarded(() => deps.readCursorHooks(path)),
          host.host_enrollment_id,
        ),
      }))
    : undefined;
  const cursorInstall = host.harnesses.includes("cursor")
    ? installedCursor(host.cursor_execpath ?? undefined, deps)
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
  const gateway = gatewayOf(daemon);
  const routedHarnesses = host.harnesses.filter(isBrokerableHarness);
  // Stella's base URL is written too; its credential is never brokered.
  const baseUrlHarnesses = host.harnesses.filter(isModelRoutedHarness);
  let modelBaseUrls: ModelBaseUrlHarnessState[] | undefined;
  if (deps.modelBaseUrls !== undefined && baseUrlHarnesses.length > 0) {
    try {
      modelBaseUrls = (
        await deps.modelBaseUrls.read({
          home: deps.home,
          stellaHome: dirname(deps.paths.stellaToml),
          port: gateway?.port ?? modelProxyPortFor(host),
          harnesses: baseUrlHarnesses,
        })
      ).harnesses;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  let modelCredentials: ModelCredentialHarnessState[] | undefined;
  if (deps.modelCredentials !== undefined && routedHarnesses.length > 0) {
    try {
      modelCredentials = (
        await deps.modelCredentials.read({
          home: deps.home,
          harnesses: routedHarnesses,
          helperCommand: deps.runtime.credentialHelperCommand,
        })
      ).harnesses;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  let credentialCustody: StatusReport["credentialCustody"];
  if (deps.credentialStore !== undefined) {
    try {
      credentialCustody = deps.credentialStore.status().map((c) => ({
        provider: c.provider,
        kind: c.kind,
        source: c.source,
        taken_at: c.taken_at,
      }));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  const tiers = observedTiers(daemon);
  // `revoked_at` means unenrolled on this machine: the hooks and the service
  // are gone and only the server-side revoke is pending. Reporting that as
  // enrolled (exit 0) disagreed with `tacho detect` about the same file and
  // kept the desktop app on its "enrolled" screens for a host that was not.
  const retired = host.revoked_at !== null;
  const shipping = retired
    ? undefined
    : shippingHealth(daemon, walStats, deps.now());
  const report: StatusReport = {
    enrolled: !retired,
    ...(retired ? { retired: true } : {}),
    ...(problems.length > 0 ? { problems } : {}),
    ...(gateway !== undefined ? { gateway } : {}),
    ...(modelBaseUrls !== undefined ? { modelBaseUrls } : {}),
    ...(modelCredentials !== undefined ? { modelCredentials } : {}),
    ...(credentialCustody !== undefined ? { credentialCustody } : {}),
    ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
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
      cursor_version: host.cursor_version ?? null,
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
    ...(cursorHooks !== undefined ? { cursorHooks } : {}),
    ...(cursorInstall !== undefined ? { cursorInstall } : {}),
    ...(stellaHooks !== undefined ? { stellaHooks } : {}),
    ...(claudeDesktop !== undefined ? { claudeDesktop } : {}),
    wal: {
      sessions: walStats.sessions,
      unshipped: walStats.unshipped,
      ...(walStats.oldestUnshippedAt !== undefined
        ? { oldest_unshipped_at: walStats.oldestUnshippedAt }
        : {}),
    },
    ...(shipping !== undefined ? { shipping } : {}),
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
  if (gateway !== undefined)
    deps.out(
      `Gateway     model proxy ${gateway.listening ? `listening on 127.0.0.1:${gateway.port}` : "NOT LISTENING"}, ${gateway.calls_observed} model call${gateway.calls_observed === 1 ? "" : "s"} observed since the collector started`,
    );
  for (const entry of modelBaseUrls ?? []) {
    deps.out(
      `            ${entry.harness}: ${entry.ours ? (entry.shadowedBy !== undefined ? `base URL set, but ${entry.shadowedBy.file} overrides it, so calls are not routed` : "model calls are pointed at the proxy") : (entry.leftAlone ?? "model calls are not pointed at the proxy (run `tacho enroll` to set the base URL)")}`,
    );
    // Behind a non-Anthropic base URL Claude Code inlines its whole MCP tool
    // catalog unless this key keeps tool search on; a big catalog then
    // overflows the context before the first prompt.
    if (entry.ours && entry.toolSearch?.enabled === false)
      deps.out(
        `            ${entry.harness}: env.ENABLE_TOOL_SEARCH is ${entry.toolSearch.current === null ? "not set" : JSON.stringify(entry.toolSearch.current)}, so every request carries the whole MCP tool catalog and a large one overflows the context (run \`tacho enroll\` to set it)`,
      );
  }
  for (const entry of modelCredentials ?? [])
    deps.out(`Credential  ${describeHarness(entry)}`);
  // The tier is what runs earned, not what is installed (ADR-095). `contained`
  // is the fourth word and is not available yet.
  for (const harness of host.harnesses)
    deps.out(
      `Tier        ${harness}: ${tiers[harness] ?? "no run since the collector started"}`,
    );
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
    `Service     ${deps.serviceManager.kind}: ${service.installed ? "installed" : "not installed"}, ${service.running === null ? `state unknown${service.detail ? `: ${service.detail}` : ""}` : service.running ? "running" : "not running"}`,
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
    // An enrollment before #3989 wrote `SessionEnd` as an http hook, which is
    // lost while the daemon is down. Only `tacho enroll` rewrites it.
    if (hooks.stale.length > 0)
      deps.out(
        `            outdated: ${hooks.stale.join(", ")}. Run tacho enroll again to rewrite ${hooks.stale.length === 1 ? "it" : "them"}.`,
      );
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
  if (cursorInstall !== undefined)
    deps.out(
      `Cursor      ${
        cursorInstall.foundVia === "cli"
          ? `installed as the cursor-agent CLI at ${cursorInstall.path}`
          : cursorInstall.foundVia === "app"
            ? `installed as the Cursor editor at ${cursorInstall.path}`
            : `not found on this machine, and ${CURSOR_COVERAGE_NOTE}`
      }`,
    );
  for (const entry of cursorHooks ?? []) {
    deps.out(
      `Cursor      ${entry.complete ? "complete" : "INCOMPLETE"}: ${entry.present.length} present, ${entry.missing.length} missing (${entry.path})`,
    );
    if (entry.missing.length > 0)
      deps.out(`            missing: ${entry.missing.join(", ")}`);
    // A veto hook without failClosed records and then stops denying the
    // moment the collector cannot answer, because Cursor proceeds by default
    // when a hook fails. That is a mandate that does not hold, so it is named
    // rather than counted as installed.
    if (entry.failOpenEnforcement.length > 0)
      deps.out(
        `            fails open at ${entry.failOpenEnforcement.join(", ")}: Cursor allows the action when the hook cannot answer; re-enroll to restore failClosed`,
      );
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
  if (shipping !== undefined)
    deps.out(
      `Shipping    ${shipping.healthy ? "ok" : "FAILING"}: ${shipping.detail}`,
    );
  return report;
}
