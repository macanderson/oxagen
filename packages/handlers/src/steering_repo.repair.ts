// audit-exempt: the security event taxonomy has no type for a settings repair, and adding one needs a migration. The kernel's capability.invoke_* row records the call and its actor.
//
// steering_repo.repair.ts: repair_steering_repo (steering-repo-spec, Settings
// drift; lane S2, #4560).
//
// The health banner's Repair settings button calls this. The work lives in
// ./steering-repo/repair, which loads the GitHub and GitLab clients, so the
// handler imports it only when a repair runs.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { steeringRepoRepair } from "@oxagen/oxagen/contracts/steering_repo.repair";
import { assertContractRole } from "./lib/capability-role-guard";

export const repairSteeringRepoHandler: CapabilityHandler<
  typeof steeringRepoRepair
> = async (_input, ctx) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(steeringRepoRepair, ctx);
  if (!ctx.workspaceId)
    throw new Error("[repair_steering_repo] workspaceId is required (scoped capability)");
  const { repair } = await import("./steering-repo/repair");
  return repair(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    { actorUserId: ctx.userId },
  );
};
