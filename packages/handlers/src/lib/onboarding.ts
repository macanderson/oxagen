// onboarding.ts: the writes on `org.onboarding_state` that other handlers
// make in passing (#2967). `create_org` opens the gate, `create_workspace`
// fills in its workspace when `create_org` made none (#4582), and
// `ingest_tacho_events` closes it on the first frame. The gate's own handlers
// (get, advance) read and write the row directly.
import { createHash } from "node:crypto";
import { schema, type Tx } from "@oxagen/database";
import { and, eq, isNull, ne } from "drizzle-orm";

/**
 * The repository a host's git remote names, as `enroll_host` records it on
 * the gate row (`detected_repository`).
 */
interface DetectedRepository {
  provider: "github";
  owner: string;
  name: string;
}

/**
 * The gate's first row, written by `create_org` in its bootstrap transaction.
 * `workspaceId` is null when `create_org` made no workspace, and
 * `claimOnboardingGateWorkspace` fills it in later.
 */
export async function openOnboardingGate(
  tx: Tx,
  args: { orgId: string; workspaceId: string | null; now: Date },
): Promise<void> {
  await tx.insert(schema.onboardingState).values({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    step: "wrap",
    createdAt: args.now,
    updatedAt: args.now,
  });
}

/**
 * Point a gate with no workspace at the organization's first workspace.
 * `create_workspace` calls this in the transaction that makes the workspace.
 * The UPDATE matches only while `workspace_id` is NULL, so the first
 * workspace wins and a later one leaves the gate alone. An organization whose
 * gate already names a workspace, or that has no gate row, is not touched.
 * Returns whether this call filled it in.
 */
export async function claimOnboardingGateWorkspace(
  tx: Tx,
  args: { orgId: string; workspaceId: string; now: Date },
): Promise<boolean> {
  const claimed = await tx
    .update(schema.onboardingState)
    .set({ workspaceId: args.workspaceId, updatedAt: args.now })
    .where(
      and(
        eq(schema.onboardingState.orgId, args.orgId),
        isNull(schema.onboardingState.workspaceId),
      ),
    )
    .returning({ orgId: schema.onboardingState.orgId });
  return claimed.length > 0;
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

/** The agent harnesses Tacho writes hooks for on an enrolled host. */
const HOST_WRAPPED_HARNESSES: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "cursor",
  "stella",
]);

/**
 * The scripted enroll command printed beside a one-time token (spec §14.1).
 *
 * A hook-based harness is named with `--harness`, because `tacho enroll`
 * hooks Claude Code when the flag is absent: a Cursor agent enrolled without
 * it would leave ~/.cursor/hooks.json unwritten and its runs unrecorded. Any
 * other harness gets the bare command.
 */
export function enrollCommandFor(token: string, harness: string): string {
  const base = `oxagen agent enroll --token ${token}`;
  return HOST_WRAPPED_HARNESSES.has(harness)
    ? `${base} --harness ${harness}`
    : base;
}

const GITHUB_REMOTE = [
  // git@github.com:owner/name.git · ssh://git@github.com/owner/name
  /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  // https://github.com/owner/name(.git)
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
];

/**
 * The repository a git remote names, for the remotes GitHub issues. Anything
 * else is null, and nothing is recorded.
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
