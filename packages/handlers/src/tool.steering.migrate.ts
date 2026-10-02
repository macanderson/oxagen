// audit-exempt: the security event taxonomy has no type for opening a steering PR, and adding one needs a migration. The kernel's capability.invoke_* row records the call and its actor, and the PR itself is the reviewed record of the change.
//
// tool.steering.migrate.ts: migrate_tools_to_steering (ADR-209 §5, ADR-245,
// #4948).
//
// An org Owner or Admin starts or retries the move of the workspace's
// connected MCP servers into its steering repo. The run lives in
// ./mcp-studio/migration-run, and its dependencies in
// ./mcp-studio/migration-deps, which load the host clients, so the handler
// imports them only when a migration runs. Steering repo provisioning calls
// the same run when a workspace's repo is ready.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolSteeringMigrate } from "@oxagen/oxagen/contracts/tool.steering.migrate";
import { assertContractRole } from "./lib/capability-role-guard";

export const migrateToolsToSteeringHandler: CapabilityHandler<
  typeof toolSteeringMigrate
> = async (_input, ctx) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(toolSteeringMigrate, ctx);
  if (!ctx.workspaceId)
    throw new Error("[migrate_tools_to_steering] workspaceId is required (scoped capability)");
  const [{ runToolMigration }, { toolMigrationDeps }] = await Promise.all([
    import("./mcp-studio/migration-run"),
    import("./mcp-studio/migration-deps"),
  ]);
  return runToolMigration(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    { actorUserId: ctx.userId },
    toolMigrationDeps(),
  );
};
