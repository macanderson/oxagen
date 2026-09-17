/**
 * What a machine-bound API key is allowed to invoke.
 *
 * ## The hole this closes
 *
 * An API key principal carries no `org_users` row, so `assertCallerRole`
 * returns early for one (`packages/handlers/src/lib/capability-role-guard.ts`)
 * and every role gate passes. Its docblock says the authority of such a key
 * "is the `scope` column on `auth.api_keys` … enforced at the auth layer."
 * That was true of nothing: `resolveApiKey` does not read `scope`, and
 * `checkIAM`'s tier fast-path allows every non-enterprise org outright, so a
 * key minted for one narrow machine job could invoke **any** capability on
 * any surface it could reach.
 *
 * That is load-bearing for Tacho. Enrollment mints the host key with
 * `scope.purpose = "tacho_host_v1"` and records the enrolling Owner/Admin as
 * its creator. With ADR-078's local MCP gateway, that key is what a connected
 * app's tool calls are forwarded with — so a connected desktop app held owner
 * authority over the workspace and could call MCP-only operations such as
 * `set_model_credential`, whose handlers accept `userId: null`. The mandate
 * the product is built on was decoration.
 *
 * This module is the enforcement the docblock promised: a key whose scope
 * names a purpose may invoke only what that purpose is for, and nothing else.
 *
 * ## Why here
 *
 * In `bootstrap.ts`'s adapter, **before** `checkIAM`, so it is:
 *
 *   - unconditional — it runs for every org tier, ahead of the fast-path that
 *     allows non-enterprise orgs without consulting IAM at all;
 *   - unforgettable — one gate on the single `invoke()` path, rather than a
 *     guard each handler has to remember (the pattern that produced this bug);
 *   - fail-closed — a purpose with no entry here is allowed nothing, so a
 *     machine credential added later is refused until somebody says what it is
 *     for.
 *
 * It constrains machine keys only. A key with no `purpose` is what
 * `oxagen login` mints for a person, and it keeps acting for its creator
 * exactly as before.
 */
import { schema, withSystemDb } from "@oxagen/database";
import { getCapability } from "@oxagen/oxagen";
import { and, eq, isNull } from "drizzle-orm";

/** The scope purpose Tacho enrollment mints the host's control-plane key with. */
export const TACHO_HOST_PURPOSE = "tacho_host_v1";

/** The scope purpose for the key the local MCP gateway serves tools with. */
export const TACHO_GATEWAY_PURPOSE = "tacho_gateway_v1";

/** The scope purpose a Stella operational-telemetry install is enrolled with. */
export const STELLA_TELEMETRY_PURPOSE = "stella_operational_telemetry_v1";

/**
 * Exactly what each machine purpose may invoke.
 *
 * These are enumerated, not derived, because a machine credential's job is
 * known when it is minted and should not silently widen when a capability is
 * added elsewhere. `tacho_gateway_v1` is the exception and is described below.
 */
export const MACHINE_KEY_CAPABILITIES: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  // The three calls `createControlClient` makes, and nothing else. A host
  // reports events, fetches its mandate, and polls for commands; it does not
  // enroll, revoke, or read the fleet.
  [TACHO_HOST_PURPOSE]: new Set([
    "ingest_tacho_events",
    "get_tacho_bundle",
    "fetch_tacho_commands",
  ]),
  [STELLA_TELEMETRY_PURPOSE]: new Set(["ingest_stella_operational_telemetry"]),
};

/**
 * `tacho_gateway_v1` is the one purpose whose allowance is a rule rather than
 * a list, because the whole point of the connected tier is to serve the
 * workspace's toolbelt — a set that grows — and a hand-maintained list would
 * drift into either uselessness or over-grant.
 *
 * The rule is the mandate, stated once:
 *
 *   - the capability is exposed on `mcp`, so it is something a tool client is
 *     meant to call at all;
 *   - it does not mutate, so a connected app cannot change the workspace;
 *   - it is not high-sensitivity, so the read-only carve-out cannot be used to
 *     read secrets, credentials or audit material.
 *
 * Anything outside that is a deliberate mandate change, not an accident of
 * which contracts happen to exist. This is narrower than what a *wrapped*
 * agent may do, and deliberately so: a connected app has no hook, so a call it
 * makes is the only thing Oxagen sees of it.
 */
export function gatewayMayInvoke(capabilityName: string): boolean {
  const capability = getCapability(capabilityName);
  if (capability === undefined) return false;
  const surfaces: readonly string[] = capability.surfaces ?? ["api", "mcp"];
  if (!surfaces.includes("mcp")) return false;
  if (capability.mutates !== false) return false;
  return capability.sensitivity !== "high";
}

/** What the gate was asked about. */
export interface MachineKeyCheck {
  orgId: string;
  apiKeyId: string | null | undefined;
  capabilityName: string;
}

/**
 * The scope purpose on a key, or undefined when it has none (a person's key)
 * or the key cannot be read. `withSystemDb` because this runs inside the
 * kernel's IAM adapter, which is identity resolution: the answer decides
 * whether the caller may touch the tenant at all.
 */
async function purposeOf(
  orgId: string,
  apiKeyId: string,
): Promise<string | undefined> {
  const key = await withSystemDb((tx) =>
    tx.query.apiKeys.findFirst({
      where: and(
        eq(schema.apiKeys.id, apiKeyId),
        eq(schema.apiKeys.orgId, orgId),
        isNull(schema.apiKeys.deletedAt),
      ),
      columns: { scope: true },
    }),
  );
  const scope = key?.scope;
  if (scope === null || typeof scope !== "object") return undefined;
  const purpose = (scope as { purpose?: unknown }).purpose;
  return typeof purpose === "string" ? purpose : undefined;
}

/**
 * Why this machine key may not invoke this capability, or undefined when it
 * may — or when the caller is not a machine key at all.
 *
 * The message names the purpose and the capability, because the operator who
 * sees it in a connected app has no other way to tell a mandate refusal from a
 * bug.
 */
export async function machineKeyDenial(
  check: MachineKeyCheck,
): Promise<string | undefined> {
  const { apiKeyId, orgId, capabilityName } = check;
  if (!apiKeyId || !orgId) return undefined;

  const purpose = await purposeOf(orgId, apiKeyId);
  // No purpose: a person's key, acting for its creator. Unchanged.
  if (purpose === undefined) return undefined;

  if (purpose === TACHO_GATEWAY_PURPOSE) {
    return gatewayMayInvoke(capabilityName)
      ? undefined
      : `Forbidden: ${capabilityName} is outside this agent's mandate. A connected app may call read-only, non-sensitive workspace tools through the Oxagen gateway; changing that is a mandate change, made in Oxagen.`;
  }

  const allowed = MACHINE_KEY_CAPABILITIES[purpose];
  // An unrecognised purpose is allowed nothing. A machine credential this
  // build has never heard of is not a credential it can reason about.
  if (allowed === undefined) {
    return `Forbidden: this credential is bound to ${purpose}, which this deployment does not recognise, so it may not invoke ${capabilityName}.`;
  }
  return allowed.has(capabilityName)
    ? undefined
    : `Forbidden: this credential is bound to ${purpose} and may not invoke ${capabilityName}.`;
}
