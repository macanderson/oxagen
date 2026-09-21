// kill_switch.set.ts — handler for the set_kill_switch capability (MC spec
// §6.11, ARCHITECTURE.md §1.3, ADR-072, #2958).
//
// Flow:
//   1. Role gate — org Owner or Admin (assertOrgRole, INV-29).
//   2. On: resolve the target's public id to the deny the live checks match:
//      a tool version becomes a `capability` deny on the id its calls are
//      governed under; every other kind becomes a `resource_scope` deny over
//      `resourceScopeDigestOf({ kind, id })` (packages/iam/src/resource-scope.ts,
//      which the kernel's agent-run check and the gateway's gate both derive
//      from what a call carries). An unknown target is not_found; an
//      organisation other than the caller's is forbidden. Off: no lookup. The
//      row is matched by (org, workspace, kind, id), and the workspace follows
//      from the kind, so a switch whose target was deleted while it was on
//      (a revoked credential, a deleted server or agent) still clears.
//   3. In ONE transaction: write the row (insert on with `reason`, deactivate
//      off with `cleared_reason`), revoke a connection's live grants, and read
//      the deny generation back. The AFTER trigger on iam.emergency_denies
//      bumps the generation in that same transaction, so the vector returned
//      is the one every cached allow is now stale against.
//   4. When the flip changed a switch, emit tool.kill_switch_flipped. The
//      event carries the actor and the capability; the row carries the
//      target, who flipped it on and why, and who cleared it and why.
//
// Scope: a class, operator, workspace or organisation switch is written
// org-wide through withOrgDb (workspace_id NULL); the rest use withTenantDb. A
// workspace switch is org-wide because iam.emergency_denies is `workspace_nullable`
// (tenant-policy.manifest.ts): a row for another workspace would fail the
// policy's WITH CHECK. The digest over `{ kind: "workspace", id }` is what
// narrows the switch to that workspace's calls, on every reader.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  killSwitchSet,
  type KillSwitchTarget,
} from "@oxagen/oxagen/contracts/kill_switch.set";
import type { DenyGenerationVector } from "@oxagen/oxagen/iam";
import { schema, type Tx, withTenantDb, withOrgDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  flipKillSwitchOff,
  flipKillSwitchOn,
  readDenyGenerationVector,
  resourceScopeDigestOf,
  type KillSwitchDeny,
} from "@oxagen/iam";
import { revokeCredentialGrants } from "@oxagen/plugins";
import { and, eq, isNull } from "drizzle-orm";
import { registryCapabilityId } from "@oxagen/agent/runtime/tool-registry-facts";
import { USER_PUBLIC_ID } from "./lib/org-member";

/** What a target resolves to before a switch is turned on. */
interface ResolvedTarget {
  readonly deny: KillSwitchDeny;
  /** The connection to revoke grants on, for a connection switch. */
  readonly connectionId: string | null;
}

/** The workspace a switch's row is written under: the caller's, or null for an org-wide switch. */
function switchWorkspaceOf(
  kind: KillSwitchTarget["kind"],
  callerWorkspaceId: string,
): string | null {
  switch (kind) {
    case "tool_version":
    case "tool_server":
    case "connection":
    case "agent":
      return callerWorkspaceId;
    case "operator":
    case "workspace":
    case "org":
    case "class":
      return null;
  }
}

/** The lookups that turn a public id into a deny; injectable for tests. */
export interface KillSwitchTargetLookups {
  toolVersion(
    scope: { orgId: string; workspaceId: string },
    publicId: string,
  ): Promise<{ capabilityId: string } | null>;
  mcpServer(
    scope: { orgId: string; workspaceId: string },
    publicId: string,
  ): Promise<{ id: string } | null>;
  connection(
    scope: { orgId: string; workspaceId: string },
    publicId: string,
  ): Promise<{ id: string } | null>;
  agent(
    scope: { orgId: string; workspaceId: string },
    publicId: string,
  ): Promise<{ publicId: string } | null>;
  /**
   * Resolves the operator's `usr_…` public id, or (backward compatibility)
   * their raw user uuid, to the user within the org: the raw uuid for the
   * live gate's digest, the public id unchanged (#3147). Null when the id
   * names nobody in this org.
   */
  resolveOperator(
    orgId: string,
    idOrPublicId: string,
  ): Promise<{ userId: string; publicId: string } | null>;
  workspace(orgId: string, workspaceId: string): Promise<boolean>;
}

const postgresKillSwitchTargetLookups: KillSwitchTargetLookups = {
  toolVersion: async (scope, publicId) => {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({
          source: schema.tools.source,
          slug: schema.tools.slug,
          name: schema.tools.name,
          mcpServerId: schema.tools.mcpServerId,
        })
        .from(schema.toolVersions)
        .innerJoin(
          schema.tools,
          eq(schema.tools.id, schema.toolVersions.toolId),
        )
        .where(
          and(
            eq(schema.toolVersions.orgId, scope.orgId),
            eq(schema.toolVersions.workspaceId, scope.workspaceId),
            eq(schema.toolVersions.publicId, publicId),
            isNull(schema.tools.deletedAt),
          ),
        )
        .limit(1),
    );
    return row ? { capabilityId: registryCapabilityId(row) } : null;
  },
  mcpServer: async (scope, publicId) => {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ id: schema.mcpServers.id })
        .from(schema.mcpServers)
        .where(
          and(
            eq(schema.mcpServers.orgId, scope.orgId),
            eq(schema.mcpServers.workspaceId, scope.workspaceId),
            eq(schema.mcpServers.publicId, publicId),
            isNull(schema.mcpServers.deletedAt),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },
  connection: async (scope, publicId) => {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ id: schema.mcpCredentials.id })
        .from(schema.mcpCredentials)
        .where(
          and(
            eq(schema.mcpCredentials.orgId, scope.orgId),
            eq(schema.mcpCredentials.workspaceId, scope.workspaceId),
            eq(schema.mcpCredentials.publicId, publicId),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },
  agent: async (scope, publicId) => {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ publicId: schema.agents.publicId })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.orgId, scope.orgId),
            eq(schema.agents.workspaceId, scope.workspaceId),
            eq(schema.agents.publicId, publicId),
            isNull(schema.agents.deletedAt),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },
  resolveOperator: async (orgId, idOrPublicId) => {
    const isPublicId = USER_PUBLIC_ID.test(idOrPublicId);
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ id: schema.users.id, publicId: schema.users.publicId })
        .from(schema.users)
        .innerJoin(schema.orgUsers, eq(schema.orgUsers.userId, schema.users.id))
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            isPublicId
              ? eq(schema.users.publicId, idOrPublicId)
              : eq(schema.users.id, idOrPublicId),
          ),
        )
        .limit(1),
    );
    return row ? { userId: row.id, publicId: row.publicId } : null;
  },
  workspace: async (orgId, workspaceId) => {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.orgId, orgId),
            eq(schema.workspaces.id, workspaceId),
          ),
        )
        .limit(1),
    );
    return row !== undefined;
  },
};

function notFound(target: KillSwitchTarget): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: `${target.kind}_not_found`,
    message: `No ${target.kind} ${target.id} in this scope`,
  });
}

const scopeDeny = (kind: string, id: string): KillSwitchDeny => ({
  kind: "resource_scope",
  digest: resourceScopeDigestOf({ kind, id }),
});

/** Resolve the target to its deny, or refuse. */
export async function resolveKillSwitchTarget(
  lookups: KillSwitchTargetLookups,
  ctx: { orgId: string; workspaceId: string },
  target: KillSwitchTarget,
): Promise<ResolvedTarget> {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  switch (target.kind) {
    case "tool_version": {
      // A `tool_version` switch bites only on a tool whose calls actually run
      // under the id `registryCapabilityId` returns. For `source: "mcp"` that
      // is `mcp.<server id>.<name>`, exactly what materializeTools governs an
      // external tool under, so the deny matches. For every other source it is
      // `row.slug`, which `toolSlugOf` lowercased at publish time, while the
      // gate matches on `cap.name` — the contract's own verb-first name. So a
      // switch on a NON-MCP registry tool is inert by construction. Nothing
      // executes declared tools today (the registry is a record, not a
      // dispatcher), so nothing is broken by it; it is written down so the
      // next person does not read coverage into it. Wiring a dispatcher for
      // declared tools means making these two ids one id first.
      const version = await lookups.toolVersion(scope, target.id);
      if (!version) throw notFound(target);
      return {
        deny: { kind: "capability", capabilityId: version.capabilityId },
        connectionId: null,
      };
    }
    case "tool_server": {
      const server = await lookups.mcpServer(scope, target.id);
      if (!server) throw notFound(target);
      return {
        deny: scopeDeny("tool_server", server.id),
        connectionId: null,
      };
    }
    case "connection": {
      const connection = await lookups.connection(scope, target.id);
      if (!connection) throw notFound(target);
      return {
        deny: scopeDeny("connection", connection.id),
        connectionId: connection.id,
      };
    }
    case "agent": {
      const agent = await lookups.agent(scope, target.id);
      if (!agent) throw notFound(target);
      return {
        deny: scopeDeny("agent", agent.publicId),
        connectionId: null,
      };
    }
    case "operator": {
      // The live gate's digest is computed over the acting user's raw
      // internal id (packages/iam/src/resource-scope.ts, `ctx.userId`), so
      // the deny must match that id regardless of which form the caller
      // passed (#3147).
      const operator = await lookups.resolveOperator(ctx.orgId, target.id);
      if (!operator) throw notFound(target);
      return {
        deny: scopeDeny("operator", operator.userId),
        connectionId: null,
      };
    }
    case "workspace": {
      if (!(await lookups.workspace(ctx.orgId, target.id)))
        throw notFound(target);
      return {
        deny: scopeDeny("workspace", target.id),
        connectionId: null,
      };
    }
    case "org": {
      if (target.id !== ctx.orgId) {
        throw new HandlerError({
          code: "forbidden",
          reason: "other_org",
          message: "A kill switch reaches the caller's own organisation only",
        });
      }
      return {
        deny: scopeDeny("org", target.id),
        connectionId: null,
      };
    }
    case "class":
      return {
        deny: scopeDeny("class", target.id),
        connectionId: null,
      };
  }
}

/** An on flip carries its resolved target; an off flip matches the row by target alone. */
type Flip =
  | { readonly on: true; readonly resolved: ResolvedTarget }
  | { readonly on: false };

interface FlipResult {
  switchId: string;
  changed: boolean;
  denyGeneration: DenyGenerationVector;
  grantsRevoked: number;
}

/**
 * The one transaction: the row write, the grant revocation and the
 * generation read-back. `tx` is the caller's; the table trigger bumps the
 * generation inside it, so the read sees the bumped value.
 */
async function flipInTransaction(
  tx: Tx,
  args: {
    orgId: string;
    /** The caller's workspace, whose generation vector is read back. */
    workspaceId: string;
    /** The workspace the switch's row is written under. */
    switchWorkspaceId: string | null;
    target: KillSwitchTarget;
    flip: Flip;
    reason: string;
    userId: string | null;
  },
): Promise<FlipResult> {
  const { orgId, target, flip } = args;
  let switchId: string;
  let changed: boolean;
  let grantsRevoked = 0;
  if (flip.on) {
    const { resolved } = flip;
    const flipped = await flipKillSwitchOn(tx, {
      orgId,
      workspaceId: args.switchWorkspaceId,
      target,
      deny: resolved.deny,
      reason: args.reason,
      userId: args.userId,
    });
    switchId = flipped.publicId;
    changed = flipped.changed;
    if (changed && resolved.connectionId !== null) {
      grantsRevoked = await revokeCredentialGrants(tx, {
        connectionId: resolved.connectionId,
      });
    }
  } else {
    const flipped = await flipKillSwitchOff(tx, {
      orgId,
      workspaceId: args.switchWorkspaceId,
      target,
      reason: args.reason,
      userId: args.userId,
    });
    if (flipped.publicId === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "switch_not_on",
        message: `No kill switch is on for ${target.kind} ${target.id}`,
      });
    }
    switchId = flipped.publicId;
    changed = flipped.changed;
  }
  const denyGeneration = await readDenyGenerationVector(tx, {
    orgId,
    workspaceId: args.workspaceId,
  });
  return { switchId, changed, denyGeneration, grantsRevoked };
}

interface KillSwitchSetDeps {
  lookups: KillSwitchTargetLookups;
  /** Write through the seam matching the switch row's workspace. */
  transaction<T>(
    fn: (tx: Tx) => Promise<T>,
    workspaceId: string | null,
  ): Promise<T>;
}

export function createKillSwitchSetHandler(
  deps: KillSwitchSetDeps,
): CapabilityHandler<typeof killSwitchSet> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );

    const switchWorkspaceId = switchWorkspaceOf(
      input.target.kind,
      ctx.workspaceId,
    );
    const flip: Flip = input.on
      ? {
          on: true,
          resolved: await resolveKillSwitchTarget(
            deps.lookups,
            ctx,
            input.target,
          ),
        }
      : { on: false };
    const result = await deps.transaction(
      (tx) =>
        flipInTransaction(tx, {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          switchWorkspaceId,
          target: input.target,
          flip,
          reason: input.reason,
          userId: actingUserId,
        }),
      switchWorkspaceId,
    );

    if (result.changed) {
      emitSecurityEvent({
        eventType: "tool.kill_switch_flipped",
        actorUserId: actingUserId,
        orgId: ctx.orgId,
        workspaceId: switchWorkspaceId,
        capability: killSwitchSet.name,
        outcome: "success",
        ip: ctx.clientIp ?? null,
        userAgent: null,
        requestId: ctx.requestId ?? null,
      });
    }

    return { ...result, on: input.on };
  };
}

export const killSwitchSetHandler = createKillSwitchSetHandler({
  lookups: postgresKillSwitchTargetLookups,
  transaction: (fn, workspaceId) =>
    workspaceId === null ? withOrgDb(fn) : withTenantDb(fn),
});
