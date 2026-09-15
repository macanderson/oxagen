import { defineTool } from "./_define";
import { listMembers as live } from "../workspace.member.list";

/**
 * Appendix E: `list_members` — "members with roles at either scope". Absorbs
 * `list_workspace_members`.
 *
 * This tool is live: apps/app rev1 (WL-19) registered it in place, in
 * ../workspace.member.list.ts, under its Appendix E name, and the v1
 * `list_workspace_members` no longer exists. The descriptor here composes
 * from the live contract so the carry checks in this directory keep reading
 * one schema, and it is not registered a second time.
 *
 * Three changes from the absorbed contract, each declared:
 *
 * 1. `scope` replaces `workspace_id` as the thing that selects what is listed.
 * 2. The output is an object, not a bare array. A top-level array cannot say
 *    which scope answered, and it cannot grow a cursor later without breaking
 *    every caller — the two org-scoped list contracts this batch also carries
 *    (`list_orgs`, `list_workspaces`) both learned that already.
 * 3. Field names are camelCase, matching every other contract in this group.
 */
export const listMembers = defineTool({
  name: live.name,
  domain: live.domain,
  description: live.description,
  mode: live.mode,
  surfaces: live.surfaces,
  layers: live.layers,
  scoped: live.scoped,

  absorbs: ["list_workspace_members"],
  drops: [
    {
      field: "workspace_id",
      from: "list_workspace_members",
      why: "replaced by `scope`: the snake_case spelling is not house casing (ADR-025 sibling rule), every surface ignored the value (members were always listed for the request's own workspace), and on its own the field could not express an org-scope listing, which is the half Appendix E adds",
    },
    {
      field: "joined_at",
      from: "list_workspace_members",
      why: "renamed to `joinedAt`; same value, same ISO-8601 encoding — the snake_case pair in this contract was the outlier, not the convention",
    },
  ],

  agent: live.agent,
  sensitivity: live.sensitivity,
  defaultEffect: live.defaultEffect,
  defaultRoles: live.defaultRoles,
  mutates: live.mutates,
  noBillingGate: live.noBillingGate,
  input: live.input,
  output: live.output,
});

export type {
  ListMembersInput,
  ListMembersOutput,
} from "../workspace.member.list";
