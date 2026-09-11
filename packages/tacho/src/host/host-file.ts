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
    endpoints: z
      .object({
        ingest: z.string().url(),
        bundle: z.string().url(),
        commands: z.string().url(),
      })
      .strict(),
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
    wrapper_version: z.string(),
    /** The command lines the settings and the service unit were written with. */
    hook_command: z.string().min(1),
    daemon_command: z.array(z.string()).min(1),
    /** Env values the settings merge displaced, restored by `unenroll`. */
    displaced_env: z.record(z.string(), z.string()).default({}),
    enrolled_at: z.string(),
    expires_at: z.string(),
    revoked_at: z.string().nullable().default(null),
  })
  .strict();

export type HostFile = z.output<typeof hostFileSchema>;

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
