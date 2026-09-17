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
  .strict();

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
  try {
    new URL(raw);
  } catch {
    return {
      pinned: undefined,
      warning: `TACHO_MCP_ENDPOINT is not a URL (${raw}); ignoring it rather than writing a host.json that will not load`,
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

export function readHostFile(path: string): HostFile | undefined {
  const raw = readJsonFileIfExists(path);
  if (raw === undefined) return undefined;
  return hostFileSchema.parse(raw);
}

export function writeHostFile(path: string, host: HostFile): void {
  writeSensitiveFileAtomic(path, `${JSON.stringify(host, null, 2)}\n`);
}

/** Apply a control response's facts and persist only when something moved. */
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
  if (changed) writeHostFile(path, next);
  return changed ? next : host;
}
