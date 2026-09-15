// onboarding.ts — the writes on `org.onboarding_state` that other handlers
// make in passing (#2967): `create_org` opens the gate, `ingest_tacho_events`
// closes it on the first frame. The gate's own handlers (get, advance) and
// `bind_main_repository` read and write the row directly.
import { createHash } from "node:crypto";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { PROVISIONAL_DAYS } from "@oxagen/database/schema";
import { HandlerError } from "@oxagen/oxagen";
import type { DetectedRepository } from "@oxagen/oxagen/contracts/onboarding.state.get";
import { and, eq, isNull, ne } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The provisional window's end for an organization created at `now`. */
export function provisionalUntil(now: Date): Date {
  return new Date(now.getTime() + PROVISIONAL_DAYS * DAY_MS);
}

/** The gate's first row, written by `create_org` in its bootstrap transaction. */
export async function openOnboardingGate(
  tx: Tx,
  args: { orgId: string; workspaceId: string; now: Date },
): Promise<void> {
  await tx.insert(schema.onboardingState).values({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    step: "wrap",
    provisionalUntil: provisionalUntil(args.now),
    createdAt: args.now,
    updatedAt: args.now,
  });
}

/**
 * Close the gate on the organization's first frame. The UPDATE is guarded on
 * `step <> 'unlocked'`, so the first batch to land wins and a later one
 * changes nothing; the agent the frame came from, when the host reports as a
 * registered agent, is stamped `registered_via = 'onboarding'` (mockup
 * `obUnlock`: the agent exists on the first frame). Returns whether this call
 * was the one that unlocked.
 */
export async function unlockOnboardingGate(
  tx: Tx,
  args: {
    orgId: string;
    runPublicId: string;
    agentId: string | null;
    now: Date;
  },
): Promise<boolean> {
  const unlocked = await tx
    .update(schema.onboardingState)
    .set({
      step: "unlocked",
      firstFrameAt: args.now,
      firstRunId: args.runPublicId,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(schema.onboardingState.orgId, args.orgId),
        ne(schema.onboardingState.step, "unlocked"),
      ),
    )
    .returning({ orgId: schema.onboardingState.orgId });
  if (unlocked.length === 0) return false;
  if (args.agentId !== null) {
    await tx
      .update(schema.agents)
      .set({ registeredVia: "onboarding", updatedAt: args.now })
      .where(eq(schema.agents.id, args.agentId));
  }
  return true;
}

/** `sha256:<hex>` of the raw token; the only form the store ever holds. */
export function hashEnrollmentToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

const GITHUB_REMOTE = [
  // git@github.com:owner/name.git · ssh://git@github.com/owner/name
  /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  // https://github.com/owner/name(.git)
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
];

/**
 * The repository a git remote names, for the remotes GitHub issues; anything
 * else is null and nothing is recorded — the gate offers a binding only for
 * a remote `bind_main_repository` can act on.
 */
export function parseRepositoryRemote(
  remote: string,
): DetectedRepository | null {
  const trimmed = remote.trim();
  for (const pattern of GITHUB_REMOTE) {
    const match = pattern.exec(trimmed);
    if (match?.[1] && match[2]) {
      return { provider: "github", owner: match[1], name: match[2] };
    }
  }
  return null;
}

/**
 * The provisional window's one refusal (spec App. F: "steering, records, and
 * agent definitions stay off until a main repo is bound"): a write that needs
 * somewhere to publish to is `conflict: provisional` while the workspace is
 * the gate's and no main repository is bound. Any other workspace, and the
 * gate's once `bind_main_repository` ran, passes.
 */
export async function assertWorkspaceNotProvisional(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<void> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ provisionalUntil: schema.onboardingState.provisionalUntil })
      .from(schema.onboardingState)
      .where(
        and(
          eq(schema.onboardingState.orgId, scope.orgId),
          eq(schema.onboardingState.workspaceId, scope.workspaceId),
          isNull(schema.onboardingState.mainRepoBoundAt),
        ),
      )
      .limit(1),
  );
  if (row) {
    throw new HandlerError({
      code: "conflict",
      reason: "provisional",
      message: `This workspace is provisional until ${row.provisionalUntil.toISOString()}: bind a main repository before publishing context records`,
    });
  }
}
