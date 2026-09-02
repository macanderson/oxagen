"use server";
/**
 * branch-actions.ts — server action backing the SessionSettings branch picker:
 * lists a GitHub repo's branches (name + which one is the default) for the
 * "Code" section.
 *
 * Follows the direct-handler-call pattern from
 * `_shared/code-mode-data.ts` (apps/app doesn't bootstrap the IAM kernel
 * invoke() expects — see CLAUDE.md "apps/app does not bootstrap IAM"),
 * layered with the resolveOrg/resolveWorkspace/getSessionOrRedirect scope
 * resolution from `_shared/conversation-actions.ts`. Scope resolution runs
 * OUTSIDE the try/catch (a missing session or non-member org must redirect
 * or 404 through Next's own control flow, not get swallowed into `{ error }`);
 * only the GitHub-backed handler call — the part that can genuinely fail
 * (revoked token, deleted repo, GitHub API hiccup) — is guarded.
 */
import { runInTenantScope } from "@oxagen/tenancy";
import { repoBranchListHandler } from "@oxagen/handlers/repo.branch.list";
import { logger } from "@oxagen/handlers/logger";
import type { CapabilityContext } from "@oxagen/oxagen";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

export interface BranchActionCtx {
  orgSlug: string;
  workspaceSlug: string;
}

export interface BranchListItem {
  name: string;
  isDefault: boolean;
}

export type ListRepoBranchesResult =
  | { branches: BranchListItem[]; defaultBranch: string | null }
  | { error: string };

export async function listRepoBranchesAction(
  ctx: BranchActionCtx,
  input: { owner: string; repo: string },
): Promise<ListRepoBranchesResult> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(ctx.orgSlug);
  const ws = await resolveWorkspace(org.id, ctx.workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const capabilityCtx: CapabilityContext = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  try {
    return await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      async () => {
        const out = await repoBranchListHandler(input, capabilityCtx);
        return {
          branches: out.branches.map((b) => ({
            name: b.name,
            isDefault: b.isDefault,
          })),
          defaultBranch: out.defaultBranch,
        };
      },
    );
  } catch (err) {
    logger.warn(
      {
        err,
        orgSlug: ctx.orgSlug,
        workspaceSlug: ctx.workspaceSlug,
        owner: input.owner,
        repo: input.repo,
      },
      "branch-actions: listRepoBranchesAction failed — degraded",
    );
    return { error: "Couldn't load branches for this repository. Try again." };
  }
}
