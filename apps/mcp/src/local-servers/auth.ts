// auth.ts: who is polling for local tool calls (mcp-studio-spec, Local
// servers; #4773).
//
// A machine polls with its gateway key, the key `tacho enroll` stores for
// the gateway. The key names one host enrollment, and that enrollment is the
// machine. A refusal uses the status, code and message the API's other
// machine-key routes use, so a machine reads the same answer on both origins:
// the auth middleware's messages for the key, and resolveEnrolledHost's for
// the host (@oxagen/handlers, lib/tacho-host).
import type { ApiKeyResolution } from "@oxagen/auth";
import type { KeyScope } from "@oxagen/iam/machine-key-scope";

/** The header a machine names itself in. It must match the key's enrollment. */
export const MACHINE_HEADER = "x-tacho-host";

/** The fields of a host row the check reads. */
export interface MachineHostRow {
  status: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface MachineAuthDeps {
  /** The scope purpose a gateway key carries: TACHO_GATEWAY_PURPOSE in @oxagen/iam. */
  gatewayPurpose: string;
  resolveKey(token: string): Promise<ApiKeyResolution>;
  readScope(orgId: string, apiKeyId: string): Promise<KeyScope>;
  /** The host row an enrollment names in the key's workspace, or undefined. */
  readHost(scope: { orgId: string; workspaceId: string }, enrollment: string): Promise<MachineHostRow | undefined>;
  now?(): number;
}

/** The body of a refused request, in the API's error envelope. */
export interface RefusalBody {
  error: { code: "unauthorized" | "forbidden"; message: string; reason?: string };
}

export type MachineAuthResult =
  | {
      ok: true;
      machine: string;
      /** The workspace the machine's gateway key belongs to. */
      scope: { orgId: string; workspaceId: string };
    }
  | { ok: false; status: 401 | 403; body: RefusalBody };

export type MachineHeaders = Record<string, string | string[] | undefined>;

// The same words apps/api/src/middleware/auth.ts answers with.
const KEY_MESSAGES: Record<string, string> = {
  malformed: "Malformed API key",
  invalid: "Invalid API key",
  expired: "API key expired",
  purpose_locked: "API key is locked to a purpose this surface does not serve",
  workspace_archived:
    "This API key's workspace is archived; restore the workspace or use a key in an active one",
};

const SSO_REQUIRED_MESSAGE =
  "This organization requires single sign-on. The person who created this key must sign in through SSO.";

function unauthorized(message: string): MachineAuthResult {
  return { ok: false, status: 401, body: { error: { code: "unauthorized", message } } };
}

function forbidden(message: string, reason?: string): MachineAuthResult {
  const error: RefusalBody["error"] = { code: "forbidden", message };
  if (reason !== undefined) error.reason = reason;
  return { ok: false, status: 403, body: { error } };
}

function headerOf(headers: MachineHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The bearer token in an Authorization header, or null when there is none. */
export function bearerOf(headers: MachineHeaders): string | null {
  const header = headerOf(headers, "authorization");
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

/** Checks a machine's poll or reply, and names the machine it speaks for. */
export function createMachineAuth(deps: MachineAuthDeps): (headers: MachineHeaders) => Promise<MachineAuthResult> {
  const now = deps.now ?? Date.now;
  return async (headers) => {
    const token = bearerOf(headers);
    if (token === null) return unauthorized("Missing credentials");
    const key = await deps.resolveKey(token);
    if (!key.ok) {
      if (key.kind === "sso_required") return forbidden(SSO_REQUIRED_MESSAGE);
      if (key.kind === "host_revoked") return forbidden("Forbidden: Tacho host enrollment revoked", "host_revoked");
      return unauthorized(KEY_MESSAGES[key.kind] ?? "Unauthorized");
    }
    const scope = await deps.readScope(key.orgId, key.apiKeyId);
    if (scope.kind !== "purpose" || scope.purpose !== deps.gatewayPurpose || scope.hostEnrollmentId === undefined) {
      return forbidden("Forbidden: enrolled Tacho host gateway key required");
    }
    const machine = scope.hostEnrollmentId;
    if (headerOf(headers, MACHINE_HEADER) !== machine) {
      return forbidden("Forbidden: host enrollment mismatch");
    }
    const host = await deps.readHost({ orgId: key.orgId, workspaceId: key.workspaceId }, machine);
    if (host === undefined) return forbidden("Forbidden: unknown Tacho host");
    if (host.status === "revoked" || host.revokedAt !== null) {
      return forbidden("Forbidden: Tacho host enrollment revoked", "host_revoked");
    }
    // A suspended machine (#4554) gets no calls. It is not polling as far as
    // the broker knows, so a call to it reads "disconnected".
    if (host.status === "suspended") return forbidden("Forbidden: Tacho host suspended", "host_suspended");
    if (host.expiresAt.getTime() <= now()) return forbidden("Forbidden: Tacho host enrollment expired");
    return {
      ok: true,
      machine,
      scope: { orgId: key.orgId, workspaceId: key.workspaceId },
    };
  };
}
