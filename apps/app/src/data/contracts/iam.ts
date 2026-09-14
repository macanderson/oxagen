// IAM roles and the permission catalogue (spec §6.3, App. A.4).
import { z } from "zod";
import { Day, PrincipalKind, PublicId } from "./common";

/** `iam.roles.scope_kind`. */
export const RoleScope = z.enum(["org", "workspace", "agent"]);
export type RoleScope = z.infer<typeof RoleScope>;

export const Permission = z.string().regex(/^[a-z]+(\.[a-z_*]+)+$/);
export type Permission = z.infer<typeof Permission>;

export const Role = z.object({
  /** The role name, unique per organization (`workspace.owner`). */
  name: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/),
  principalKind: PrincipalKind,
  scope: RoleScope,
  /** Grants that narrow to a named resource carry its kind (`agent.repo.write(acme/platform)`). */
  resourceKind: z.enum(["repository"]).nullable(),
  builtin: z.boolean(),
  description: z.string(),
  permissions: z.array(Permission).min(1),
  createdById: PublicId.nullable(),
  createdOn: Day.nullable(),
});
export type Role = z.infer<typeof Role>;

/** A role held by a principal, optionally narrowed to one resource. */
export const RoleAssignment = z.object({
  role: Role.shape.name,
  resource: z.string().nullable(),
});
export type RoleAssignment = z.infer<typeof RoleAssignment>;

export const PermissionGroupKey = z.enum([
  "runs",
  "agents",
  "tools_policy",
  "repository",
  "graph_steering",
  "money",
  "audit",
]);
export type PermissionGroupKey = z.infer<typeof PermissionGroupKey>;

export const PermissionGroup = z.object({
  key: PermissionGroupKey,
  permissions: z.array(Permission).min(1),
});
export type PermissionGroup = z.infer<typeof PermissionGroup>;
