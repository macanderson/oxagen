// repository.init_pr.open.ts: `open_init_pr`, retired by lane S1 (#4450).
//
// This handler used to open a pull request that added the `.oxagen/` tree to
// a code repository. A workspace now gets its own steering repo when it is
// created (steering-repo-spec, Provisioning), and that job writes the first
// commit from the S0 templates (`steering_repo.provision.ts`). A code
// repository carries no `.oxagen/` tree, so there is nothing left to open.
//
// The capability stays registered so a caller that still sends it gets a
// typed refusal, `conflict: init_pr_retired`, instead of `no_handler`. The
// role gate still runs first, so the refusal tells a caller without the role
// nothing about the workspace.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import type {
  repositoryInitPrOpen,
  RepositoryInitPrOpenOutput,
} from "@oxagen/oxagen/contracts/repository.init_pr.open";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";

/** What a retired `open_init_pr` tells its caller to do instead. */
export const INIT_PR_RETIRED_MESSAGE =
  "Oxagen no longer opens an init pull request on a code repository. Each workspace gets its own steering repo when you create it, and Oxagen seeds that repo for you. Link a code repository with link_repository.";

export function createInitPrOpenHandler(): CapabilityHandler<
  typeof repositoryInitPrOpen
> {
  return async (_input, ctx): Promise<RepositoryInitPrOpenOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    throw new HandlerError({
      code: "conflict",
      reason: "init_pr_retired",
      message: INIT_PR_RETIRED_MESSAGE,
    });
  };
}

export const repositoryInitPrOpenHandler = createInitPrOpenHandler();
