// Machine groups (mcp-studio-spec, Local servers, Machines).
//
// An admin puts enrolled machines into named groups. A local server, or a
// registry package with source.machines, runs only on a machine whose group
// the server names. The cloud gateway reads these rows before it signs a
// local call envelope (packages/handlers/src/mcp-studio/local-calls/).
//
// A group is not a row of its own. It exists while at least one machine is in
// it, so removing the last machine removes the group. The machine is a
// tacho.hosts row. Both tables live in the tacho schema, so host_id is a real
// foreign key, and deleting a host deletes its memberships. Revoking a host
// keeps the rows, and the reader skips a revoked host.
//
// The migration that creates this table and its tenant policies is
// 20260927170000_machine_group_members.sql.
import { sql } from "drizzle-orm";
import { check, index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appendOnlyAuditMixin, idMixin, orgScopeMixin } from "./_mixins";
import { tachoSchema } from "./_schemas";
import { tachoHosts } from "./tacho";

// ── machine_group_members ────────────────────────────────────────────────────
// One row puts one enrolled machine in one group. A row is added or deleted,
// never updated.
export const tachoMachineGroupMembers = tachoSchema.table(
  "machine_group_members",
  {
    ...idMixin("tmg"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    groupName: text("group_name").notNull(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => tachoHosts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    memberUniq: uniqueIndex("tacho_machine_group_members_uniq").on(
      t.workspaceId,
      t.groupName,
      t.hostId,
    ),
    hostIdx: index("tacho_machine_group_members_host_idx").on(
      t.orgId,
      t.workspaceId,
      t.hostId,
    ),
    // The pattern server.toml's source.machines accepts (machineGroupSchema
    // in packages/tacho/src/collector/local-servers/wire.ts).
    groupNameCheck: check(
      "tacho_machine_group_members_group_name_check",
      sql`${t.groupName} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`,
    ),
  }),
);
