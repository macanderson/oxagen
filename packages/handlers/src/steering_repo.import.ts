// audit-exempt: the security event taxonomy has no type for a steering import, and adding one needs a migration. The kernel's capability.invoke_* row records the call and its actor, and every change the import makes is a PR on the host.
//
// steering_repo.import.ts: import_workspace_steering (steering spec,
// Workspace migration; lane S10, #4620, ADR-219).
//
// A workspace owner runs it once per workspace. It moves the workspace's
// steering from `.oxagen/` in the repository it binds to a steering repo and
// opens the steering PRs a person merges. The run is in
// ./steering-repo/import-run.ts; its database and host calls are in
// ./steering-repo/import-deps.ts, which load the host clients, so the handler
// imports both only when an import runs.
import { resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { steeringRepoImport } from "@oxagen/oxagen/contracts/steering_repo.import";
import { assertContractRole } from "./lib/capability-role-guard";

export const importWorkspaceSteeringHandler: CapabilityHandler<
  typeof steeringRepoImport
> = async (input, ctx) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(steeringRepoImport, ctx);
  if (!ctx.workspaceId)
    throw new Error(
      "[import_workspace_steering] workspaceId is required (scoped capability)",
    );
  // The binding the provisioner writes names this person as its author.
  const actorUserId = await resolveActingUserId(ctx);
  if (!actorUserId)
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  const [{ runSteeringImport }, { steeringImportDeps }] = await Promise.all([
    import("./steering-repo/import-run"),
    import("./steering-repo/import-deps"),
  ]);
  return runSteeringImport(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    {
      ...(input.ruleKinds ? { ruleKinds: input.ruleKinds } : {}),
      ...(input.constraintEffects
        ? { constraintEffects: input.constraintEffects }
        : {}),
      ...(input.startFresh ? { startFresh: true } : {}),
    },
    steeringImportDeps({ actorUserId }),
  );
};
