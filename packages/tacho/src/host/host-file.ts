/**
 * `host.json` (spec section 5.1 step 3): the host's enrollment identity,
 * its scoped API key, the endpoints from the signed claims, the cached
 * bundle, and the local listener settings. Mode 0600; written atomically.
 */
import { z } from "zod";
import {
  denyGenerationSchema,
  enrollmentClaimsSchema,
  policyBundleSchema,
  tachoHostStatusSchema,
  tachoPlatformSchema,
} from "../wire";
import { readJsonFileIfExists, writeSensitiveFileAtomic } from "./fs";

export const HOST_FILE_SCHEMA = "tacho.host.v1" as const;

export const hostFileSchema = z
  .object({
    schema: z.literal(HOST_FILE_SCHEMA),
    host_enrollment_id: z.string().min(1),
    agent_key: z.string().min(1),
    organization_id: z.string().min(1),
    workspace_id: z.string().min(1),
    /** The slugs the org-scoped routes take (`/v1/<org>/<workspace>/...`). */
    org_slug: z.string().min(1),
    workspace_slug: z.string().min(1),
    api_url: z.string().url(),
    api_key: z.string().min(1),
    api_key_public_id: z.string().min(1),
    /**
     * The credential the local MCP gateway presents (ADR-078), distinct from
     * `api_key`. Optional: a host enrolled before the gateway existed has
     * none, and one that has none serves no tools -- it never falls back to
     * `api_key`, because a connected app holding the host's authority is the
     * escalation the split exists to prevent.
     */
    gateway_api_key: z.string().min(1).optional(),
    gateway_api_key_public_id: z.string().min(1).optional(),
    endpoints: z
      .object({
        ingest: z.string().url(),
        bundle: z.string().url(),
        commands: z.string().url(),
        /**
         * The workspace MCP endpoint the local gateway proxies to (ADR-078).
         * Optional: a host enrolled before the gateway existed has no such
         * claim, and `mcpEndpointFor` derives one so the file still loads
         * and the host still works.
         */
        mcp: z.string().url().optional(),
      })
      .strict(),
    /**
     * The MCP endpoint an operator pinned with `TACHO_MCP_ENDPOINT` when this
     * host enrolled, persisted so the daemon can read it.
     *
     * Deliberately NOT a member of `endpoints`: those are the endpoints the
     * control plane stated in the signed claims, and the claims omit plaintext
     * endpoints on purpose. This is the host's own local configuration, and it
     * is kept here for the same reason `port` and `local_token` are — tachod
     * runs as a background service that `enroll` installs with a deliberately
     * small environment (`TACHO_HOME`, `CLAUDE_CONFIG_DIR`, `PATH`, `HOME`),
     * so a variable exported in the enrolling shell never reaches it. Without
     * this, a local stack's `http://127.0.0.1:4100/mcp` was known only inside
     * the enroll process: the launched daemon derived `http://localhost:4000/mcp`
     * from `api_url` and sent every connected-app tool call at the API port.
     *
     * Optional, so a host enrolled before this field existed still loads.
     */
    mcp_endpoint_override: z.string().url().optional(),
    enrollment: z
      .object({
        claims: enrollmentClaimsSchema,
        signature_hex: z.string(),
      })
      .strict(),
    bundle: policyBundleSchema,
    bundle_public_key_pem: z.string().min(1),
    bundle_fetched_at: z.string(),
    /** Newest deny generation seen from any control response. */
    deny_generation: denyGenerationSchema,
    host_status: tachoHostStatusSchema,
    device_key_fingerprint: z.string().min(1),
    device_public_key: z.string().min(1),
    port: z.number().int().min(1024).max(65535),
    /**
     * The loopback port of the daemon's model proxy (story sheet item 10).
     * Optional: a host enrolled before the proxy existed has none, and
     * `modelProxyPortFor` derives the port next to `port` so the file still
     * loads and the daemon still serves the proxy.
     */
    model_proxy_port: z.number().int().min(1024).max(65535).optional(),
    /** Opt-in repository Git proxy; configured by tacho github configure. */
    github_broker_enabled: z.boolean().optional(),
    github_repositories: z
      .array(
        z
          .object({
            cwd: z.string(),
            repository: z.string(),
            url: z.string(),
            helper: z.string(),
            remotes: z.array(
              z
                .object({
                  key: z.string(),
                  before: z.array(z.string()),
                  after: z.array(z.string()),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
    local_token: z.string().min(16),
    hostname: z.string(),
    os_user: z.string(),
    platform: tachoPlatformSchema,
    harnesses: z.array(z.string()).min(1),
    managed: z.boolean(),
    claude_version: z.string().nullable(),
    claude_execpath: z.string().nullable(),
    /** Present once a host enrolls with `--harness codex`. */
    codex_version: z.string().nullable().optional(),
    codex_execpath: z.string().nullable().optional(),
    /** Present once a host enrolls with `--harness cursor`. */
    cursor_version: z.string().nullable().optional(),
    cursor_execpath: z.string().nullable().optional(),
    /** Present once a host enrolls with `--harness stella`. */
    stella_version: z.string().nullable().optional(),
    stella_execpath: z.string().nullable().optional(),
    wrapper_version: z.string(),
    /** The command lines the settings and the service unit were written with. */
    hook_command: z.string().min(1),
    daemon_command: z.array(z.string()).min(1),
    /** Env values the settings merge displaced, restored by `unenroll`. */
    displaced_env: z.record(z.string(), z.string()).default({}),
    /**
     * argv for the MCP stdio shim, written into a connected app's config
     * (ADR-078). Optional: a host enrolled before the connected tier existed
     * has none, and it is only needed when a connected harness is enrolled.
     */
    mcp_stdio_command: z.array(z.string()).min(1).optional(),
    /**
     * MCP servers the merge displaced from our key in a connected app's
     * config, per harness, restored by `unenroll`. The `mcpServers` map is
     * keyed by name, so unlike a hook a colliding entry cannot simply sit
     * beside ours; this is the `displaced_env` of the connected tier.
     */
    displaced_mcp_servers: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .default({}),
    enrolled_at: z.string(),
    expires_at: z.string(),
    revoked_at: z.string().nullable().default(null),
  })
  // Not `.strict()`: host.json outlives the binary that wrote it. The desktop
  // app updates its sidecar while an older `tacho` stays on PATH (Homebrew, a
  // durable copy the hooks still name), and a strict schema made that older
  // binary throw on the first key a newer one added — in `unenroll` too, so
  // the machine could not be uninstalled. Unknown keys are carried, not
  // dropped, so a round trip through an older binary loses nothing.
  .passthrough();

export type HostFile = z.output<typeof hostFileSchema>;

/** What `TACHO_MCP_ENDPOINT` asked for, and whether it can be honoured. */
export interface McpEndpointOverrideRequest {
  /** The value to write into `host.json`, or undefined to pin nothing. */
  readonly pinned: string | undefined;
  /**
   * Set when the variable carried something non-empty that cannot be pinned.
   * It is returned rather than logged so every caller reports it the same
   * way — which is the whole point of deciding here. When the fresh-enrollment
   * and re-apply paths each judged the variable for themselves, they drifted:
   * one warned, the other silently kept the endpoint it already had.
   */
  readonly warning: string | undefined;
}

/**
 * Read `TACHO_MCP_ENDPOINT` into the decision both enrollment paths act on.
 *
 * The URL parse is not decoration. `mcp_endpoint_override` is declared
 * `z.string().url()`, `writeHostFile` does not validate and `readHostFile`
 * does, so persisting whatever the shell happened to export would let one
 * malformed variable write a `host.json` that every later read rejects — the
 * host would be bricked by a typo rather than falling back to the endpoint it
 * would otherwise derive. Refusing it is right; refusing it quietly is not,
 * so the reason travels back with the verdict.
 */
export function mcpEndpointOverrideRequestFrom(
  env: Record<string, string | undefined>,
): McpEndpointOverrideRequest {
  const raw = env["TACHO_MCP_ENDPOINT"];
  if (typeof raw !== "string" || raw.length === 0)
    return { pinned: undefined, warning: undefined };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      pinned: undefined,
      warning: `TACHO_MCP_ENDPOINT is not a URL (${raw}); ignoring it rather than writing a host.json that will not load`,
    };
  }
  // Parsing is not enough. `new URL("localhost:4100/mcp")` SUCCEEDS — it reads
  // `localhost:` as the scheme — so the commonest typo, omitting `https://`,
  // parses clean and persists. The gateway then hands that value to `fetch`,
  // which refuses the scheme on every connected-app tool call. `ftp:` and
  // `file:` get in the same way.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      pinned: undefined,
      warning: `TACHO_MCP_ENDPOINT is not an http(s) URL (${raw}); ignoring it rather than pinning an endpoint fetch will refuse`,
    };
  }
  return { pinned: raw, warning: undefined };
}

/**
 * The workspace MCP endpoint for this host: `TACHO_MCP_ENDPOINT` in the
 * reading process, then the override this host enrolled with, then the signed
 * claim, then a derivation from `api_url`.
 *
 * The persisted override sits above the claim because it is the same value the
 * live variable carries — a local stack pointing at `127.0.0.1:4100` — and a
 * precedence that changed depending on which process asked would make the
 * daemon and the CLI disagree about where the gateway proxies to.
 *
 * The derivation exists so a host enrolled before ADR-078 keeps working
 * without re-enrolling. It is a last resort, not the design: the endpoint is
 * a fact the control plane states, and a deployment whose MCP host is not its
 * API host with `api` swapped for `mcp` must set the claim or the env var.
 */
export function mcpEndpointFor(
  host: Pick<HostFile, "api_url" | "endpoints"> &
    Partial<Pick<HostFile, "mcp_endpoint_override">>,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env["TACHO_MCP_ENDPOINT"];
  if (typeof override === "string" && override.length > 0) return override;
  const pinned = host.mcp_endpoint_override;
  if (typeof pinned === "string" && pinned.length > 0) return pinned;
  if (host.endpoints.mcp !== undefined) return host.endpoints.mcp;
  const api = new URL(host.api_url);
  api.hostname = api.hostname.replace(/^api\./, "mcp.");
  api.pathname = "/mcp";
  api.search = "";
  return api.toString().replace(/\/$/, "");
}

/**
 * The port the model proxy listens on, and the one enrollment writes into a
 * harness's base URL. The pinned value when `host.json` carries one, otherwise
 * the port after the collector's, or the one before it at the top of the range.
 */
export function modelProxyPortFor(
  host: Pick<HostFile, "port"> & Partial<Pick<HostFile, "model_proxy_port">>,
): number {
  if (host.model_proxy_port !== undefined) return host.model_proxy_port;
  return host.port < 65535 ? host.port + 1 : host.port - 1;
}

export function readHostFile(path: string): HostFile | undefined {
  const raw = readJsonFileIfExists(path);
  if (raw === undefined) return undefined;
  return hostFileSchema.parse(raw);
}

export interface LenientHostRead {
  /** The parsed host, when the file is there and valid. */
  host?: HostFile;
  /**
   * What could be recovered from a file that did not validate: enough for
   * `unenroll` to strip this enrollment's hooks and put back what it
   * displaced. Undefined when the file is absent or is not a JSON object.
   */
  salvaged?: Pick<
    HostFile,
    | "host_enrollment_id"
    | "displaced_env"
    | "displaced_mcp_servers"
    | "github_repositories"
  >;
  /** Malformed custody receipts must be repaired before stopping the proxy. */
  githubRecoveryError?: string;
  /** Why the file did not validate. */
  error?: string;
}

/**
 * Read host.json without throwing. The commands that take a machine apart or
 * report on it (`unenroll`, `status`, `detect`) must work on a host file that
 * is truncated, hand-edited or from another version: a throw there leaves a
 * machine that cannot be uninstalled.
 */
export function readHostFileLenient(path: string): LenientHostRead {
  let raw: unknown;
  try {
    raw = readJsonFileIfExists(path);
  } catch (error) {
    return {
      error: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (raw === undefined) return {};
  const parsed = hostFileSchema.safeParse(raw);
  if (parsed.success) return { host: parsed.data };
  const issue = parsed.error.issues[0];
  const error = `${path} does not validate (${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"})`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error };
  const record = raw as Record<string, unknown>;
  const github = hostFileSchema.shape.github_repositories.safeParse(
    record["github_repositories"],
  );
  const githubRecoveryError = github.success
    ? undefined
    : "GitHub custody receipts are invalid. Repair host.json before unenrolling so remote URLs can be restored.";
  const id = record["host_enrollment_id"];
  if (typeof id !== "string" || id.length === 0)
    return {
      error,
      githubRecoveryError:
        githubRecoveryError ??
        (github.success && github.data?.length
          ? "Restore the host enrollment id before removing GitHub custody"
          : undefined),
    };
  const env = z
    .record(z.string(), z.string())
    .safeParse(record["displaced_env"]);
  const servers = z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .safeParse(record["displaced_mcp_servers"]);
  return {
    error,
    githubRecoveryError,
    salvaged: {
      ...(github.success ? { github_repositories: github.data } : {}),
      host_enrollment_id: id,
      displaced_env: env.success ? env.data : {},
      displaced_mcp_servers: servers.success ? servers.data : {},
    },
  };
}

/** The harness list and the enrollment id they belong to, read as one pair. */
export interface CurrentEnrollment {
  harnesses: string[];
  enrollmentId: string;
  /**
   * False when host.json could not be read or did not validate, so
   * `harnesses` and `enrollmentId` are the daemon's startup copy rather than
   * a pair confirmed on disk just now. A caller that gates a
   * security-relevant check on the enrollment identity (the hook-removal
   * detector) must NOT disable itself on `verified: false`: a host whose
   * enrollment cannot currently be confirmed is exactly the host a tamper
   * detector must keep watching, and going quiet here hands an attacker the
   * evasion of making the enrollment file unreadable and then tampering
   * with what the detector was checking (docs/specs/tacho/spec.md section
   * 11's threat-model table, and section 14 acceptance item 8, neither of
   * which carries an exception for the enrollment file also being
   * unreadable). Instead, continue the check against the last pair that
   * *was* confirmed on disk (`verified: true`), and stamp `verified` onto
   * whatever evidence the check produces, so a reader can tell a check that
   * ran against a last-verified identity from one that ran against a
   * live-confirmed one (#3398; `Detector.checkHooks()` in
   * `packages/tacho/src/collector/detector.ts` is the reference caller).
   */
  verified: boolean;
}

/**
 * The harness list host.json enrolls now, and the enrollment id that list
 * belongs to, read together from the same on-disk snapshot on every call.
 *
 * The daemon's in-memory copy is the one it started with, and `reassign`
 * replaces the enrollment under a daemon that is still up, so a harness the
 * CLI dropped would otherwise stay "enrolled" until a restart, and the
 * hook-presence check would keep validating hooks against the enrollment id
 * the daemon booted with. Reading both fields out of one `readHostFileLenient`
 * call, rather than two separate reads at two separate moments, is what
 * keeps a live `reassign` from ever pairing the new harness list with the
 * old enrollment id (#3398). A missing or invalid file falls back to the
 * daemon's copy, in full, marked `verified: false`: a hand-edited host.json
 * must not make the daemon forget which agents it wraps or which enrollment
 * it wraps them under, but a caller that needs a *confirmed* identity, not
 * merely a remembered one, must see that the file could not back it.
 */
export function currentEnrollment(
  path: string,
  fallback: HostFile,
): CurrentEnrollment {
  const read = readHostFileLenient(path).host;
  const host = read ?? fallback;
  return {
    harnesses: host.harnesses,
    enrollmentId: host.host_enrollment_id,
    verified: read !== undefined,
  };
}

/**
 * The harnesses host.json enrolls now, read from disk on every call.
 *
 * A thin projection of {@link currentEnrollment} for a caller that wants
 * only the harness list, with no enrollment id to keep it paired with.
 */
export function enrolledHarnesses(path: string, fallback: HostFile): string[] {
  return currentEnrollment(path, fallback).harnesses;
}

export function writeHostFile(path: string, host: HostFile): void {
  writeSensitiveFileAtomic(path, `${JSON.stringify(host, null, 2)}\n`);
}

/**
 * Apply a control response's facts and persist only when something moved.
 *
 * The daemon holds host.json in memory for its whole life, and the CLI writes
 * the same file while the daemon runs: `enroll` records `displaced_env` and
 * `displaced_mcp_servers` after it has started the service, `unenroll` marks
 * `revoked_at` and then deletes the file, `reassign` replaces the enrollment
 * under a daemon that is still up. Writing the in-memory copy back whole
 * dropped the displaced values (so unenroll could never restore the user's
 * own env value or MCP server), put a deleted host.json and its API key back
 * on disk, and laid the old enrollment over the new one. So the facts are
 * laid over what is on disk now, and nothing is written when the file is gone
 * or names another enrollment.
 */
export function applyControlFacts(
  path: string,
  host: HostFile,
  facts: {
    host_status?: HostFile["host_status"];
    deny_generation?: HostFile["deny_generation"];
    bundle?: HostFile["bundle"];
    bundle_fetched_at?: string;
  },
): HostFile {
  const next: HostFile = { ...host };
  let changed = false;
  if (
    facts.host_status !== undefined &&
    facts.host_status !== host.host_status
  ) {
    next.host_status = facts.host_status;
    changed = true;
  }
  if (facts.deny_generation !== undefined) {
    const merged = {
      org: Math.max(host.deny_generation.org, facts.deny_generation.org),
      workspace: Math.max(
        host.deny_generation.workspace,
        facts.deny_generation.workspace,
      ),
    };
    if (
      merged.org !== host.deny_generation.org ||
      merged.workspace !== host.deny_generation.workspace
    ) {
      next.deny_generation = merged;
      changed = true;
    }
  }
  if (facts.bundle !== undefined && facts.bundle.etag !== host.bundle.etag) {
    next.bundle = facts.bundle;
    next.bundle_fetched_at =
      facts.bundle_fetched_at ?? new Date().toISOString();
    next.host_status = facts.bundle.host_status;
    changed = true;
  }
  if (!changed) return host;
  const disk = readHostFileLenient(path).host;
  if (
    disk !== undefined &&
    disk.host_enrollment_id === host.host_enrollment_id
  ) {
    writeHostFile(path, {
      ...disk,
      host_status: next.host_status,
      deny_generation: next.deny_generation,
      bundle: next.bundle,
      bundle_fetched_at: next.bundle_fetched_at,
    });
  }
  return next;
}
