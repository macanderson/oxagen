// assistant.switch.set.ts: handler for the set_assistant_switch capability.
//
// Oxagen's own switch on its in-app assistant, for one workspace. Customers
// never configure governance against the assistant (maintainer ruling,
// 2026-10-01), and set_kill_switch refuses the managed agent as a target. This
// handler writes the one row that still stops it.
//
// Flow, in one transaction inside the input workspace's tenant scope:
//   1. Find the workspace's managed assistant agent: slug `qa-chat` and
//      agent_type `interactive_chat`, not deleted. None is not_found. The slug
//      is what readAssistantAgentState (packages/agent/src/runtime/
//      assistant-run.ts) reads, so a switch can only land on the row the turn
//      checks. The type keeps a customer's own agent out of reach.
//   2. On: flipKillSwitchOn writes an `agent` kill switch under the workspace,
//      a `resource_scope` deny over resourceScopeDigestOf({ kind: "agent",
//      id: <its public id> }). That digest is what readAssistantAgentState
//      matches, so the next turn is refused with AssistantStoppedError. Off:
//      flipKillSwitchOff deactivates the row and records why. The table's
//      AFTER trigger bumps the deny generation in the same transaction.
//   3. When the flip changed the switch, emit tool.kill_switch_flipped, the
//      event set_kill_switch emits for the same row.
//
// There is no role gate here. The capability is `platformOnly`, so the kernel
// refuses it unless the context carries a platform-operator binding it minted
// itself (INV-31). The caller is an operator script with no signed-in user, so
// every actor column on the row is null, and the audit row carries the
// operator run's request id instead.
//
// Turning the switch off when none is on returns switchId null and changed
// false rather than an error, so an operator can re-run the script safely.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  assistantSwitchSet,
  type AssistantSwitchSetOutput,
} from "@oxagen/oxagen/contracts/assistant.switch.set";
import {
  INTERACTIVE_AGENT_SLUG,
  INTERACTIVE_AGENT_TYPE,
} from "@oxagen/oxagen/interactive-agent";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import {
  flipKillSwitchOff,
  flipKillSwitchOn,
  resourceScopeDigestOf,
} from "@oxagen/iam";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

/** The workspace the switch is written under, from the input. */
export interface AssistantSwitchScope {
  readonly orgId: string;
  readonly workspaceId: string;
}

/** What the handler reads and writes; injectable for tests. */
export interface AssistantSwitchDeps {
  /** Run `fn` in one transaction inside the workspace's tenant scope. */
  transaction<T>(
    scope: AssistantSwitchScope,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  /** The workspace's managed assistant agent, or null when it has none. */
  findAssistantAgent(
    tx: Tx,
    scope: AssistantSwitchScope,
  ): Promise<{ publicId: string } | null>;
  flipOn: typeof flipKillSwitchOn;
  flipOff: typeof flipKillSwitchOff;
}

/**
 * The workspace's managed assistant agent: the `qa-chat` slug
 * readAssistantAgentState reads, with the `interactive_chat` type that marks it
 * product-managed. Exported for its test.
 */
export async function findManagedAssistantAgent(
  tx: Tx,
  scope: AssistantSwitchScope,
): Promise<{ publicId: string } | null> {
  const [row] = await tx
    .select({ publicId: schema.agents.publicId })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
        eq(schema.agents.slug, INTERACTIVE_AGENT_SLUG),
        eq(schema.agents.agentType, INTERACTIVE_AGENT_TYPE),
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function createAssistantSwitchSetHandler(
  deps: AssistantSwitchDeps,
): CapabilityHandler<typeof assistantSwitchSet> {
  return async (input, ctx): Promise<AssistantSwitchSetOutput> => {
    const scope: AssistantSwitchScope = {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
    };
    const result = await deps.transaction(scope, async (tx) => {
      const agent = await deps.findAssistantAgent(tx, scope);
      if (!agent) {
        throw new HandlerError({
          code: "not_found",
          reason: "assistant_agent_not_found",
          message: `Workspace ${input.workspaceId} in organization ${input.orgId} has no managed assistant agent`,
        });
      }
      const target = { kind: "agent" as const, id: agent.publicId };
      const flipped = input.on
        ? await deps.flipOn(tx, {
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            target,
            deny: {
              kind: "resource_scope",
              digest: resourceScopeDigestOf(target),
            },
            reason: input.reason,
            userId: null,
          })
        : await deps.flipOff(tx, {
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            target,
            reason: input.reason,
            userId: null,
          });
      return { switchId: flipped.publicId, changed: flipped.changed };
    });

    if (result.changed) {
      // Awaited: the caller is a process that exits as soon as the invoke
      // returns, and a fire-and-forget insert would race closeDatabase() and
      // process.exit. A row that fails all its retries rejects here, after the
      // switch is written. The operator sees the failure, and a re-run finds
      // the switch already in place.
      await emitSecurityEventAsync({
        eventType: "tool.kill_switch_flipped",
        actorUserId: null,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        capability: assistantSwitchSet.name,
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: ctx.requestId ?? null,
      });
    }

    logger.info(
      {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        on: input.on,
        switchId: result.switchId,
        changed: result.changed,
        requestId: ctx.requestId,
      },
      "assistant.switch.set: assistant switch flipped",
    );

    return result;
  };
}

export const assistantSwitchSetHandler = createAssistantSwitchSetHandler({
  transaction: (scope, fn) =>
    runInTenantScope(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        capabilityName: assistantSwitchSet.name,
      },
      () => withTenantDb(fn),
    ),
  findAssistantAgent: findManagedAssistantAgent,
  flipOn: flipKillSwitchOn,
  flipOff: flipKillSwitchOff,
});
