// migration-deps.ts: the production dependencies of migrate_tools_to_steering
// (migration-run.ts). The run touches no database and no host. This file is
// the one place that does.
//
// Every query runs inside the caller's tenant scope and filters on its orgId
// and workspaceId: the kernel's scope when a person calls the capability, or
// the scope provisioning opens when a steering repo becomes ready.
import {
  listMovableLegacyServers,
  steeringPrOpener,
  type SteeringPrOpener,
} from "@oxagen/agent/runtime/steering-pr";
import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { TOOL_SERVERS_DIR } from "@oxagen/oxagen/steering-repo/paths";
import { and, eq, sql } from "drizzle-orm";
import type { SteeringHost } from "../context.steering.github";
import { createSteeringHost } from "../context.steering.host";
import {
  readToolMigrationRecord,
  TOOL_MIGRATION_SETTING,
  type MigrationScope,
  type ToolMigrationDeps,
  type ToolMigrationRecord,
} from "./migration-run";

/** The steering host, built on first use, so importing this file opens no host client. */
const steeringHost: () => SteeringHost = (() => {
  let host: SteeringHost | null = null;
  return () => (host ??= createSteeringHost());
})();

/** The opener boot registered (register.ts), or a refusal when none is. */
function registeredOpener(): SteeringPrOpener {
  const opener = steeringPrOpener();
  if (opener === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "steering_pr_unavailable",
      message:
        "This deployment registered no steering PR opener, so no MCP server can move into a steering repo yet.",
    });
  }
  return opener;
}

function workspaceRow(scope: MigrationScope) {
  return and(
    eq(schema.workspaces.id, scope.workspaceId),
    eq(schema.workspaces.orgId, scope.orgId),
  );
}

/** The settings bag with the `tool_migration` key set to `record`, and every other key kept. */
function settingsPatch(record: ToolMigrationRecord) {
  const column = schema.workspaces.settings;
  return sql`CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END || ${JSON.stringify({ [TOOL_MIGRATION_SETTING]: record })}::jsonb`;
}

/** The folder names under tools/servers/ that `paths` holds, each once, in name order. */
export function serverFolderNames(paths: readonly string[]): string[] {
  const prefix = `${TOOL_SERVERS_DIR}/`;
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length).split("/")[0];
    // A file directly under tools/servers/ is not a folder.
    if (name && path.length > prefix.length + name.length) names.add(name);
  }
  return [...names].sort();
}

export function toolMigrationDeps(): ToolMigrationDeps {
  return {
    now: () => new Date(),

    hasSteeringRepo: (scope) => registeredOpener().hasSteeringRepo(scope),

    movableServers: (scope) =>
      withTenantDb((tx) => listMovableLegacyServers(tx, scope)),

    async readRecord(scope) {
      const [row] = await withTenantDb((tx) =>
        tx
          .select({ settings: schema.workspaces.settings })
          .from(schema.workspaces)
          .where(workspaceRow(scope))
          .limit(1),
      );
      return readToolMigrationRecord(row?.settings ?? null);
    },

    async claim(scope, record, staleBefore) {
      const settings = schema.workspaces.settings;
      const rows = await withTenantDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ settings: settingsPatch(record) })
          .where(
            and(
              workspaceRow(scope),
              sql`NOT (
                COALESCE(${settings} #>> ${`{${TOOL_MIGRATION_SETTING},status}`}::text[], '') = 'running'
                AND COALESCE((${settings} #>> ${`{${TOOL_MIGRATION_SETTING},updated_at}`}::text[])::timestamptz, 'epoch'::timestamptz) > ${staleBefore.toISOString()}::timestamptz
              )`,
            ),
          )
          .returning({ id: schema.workspaces.id }),
      );
      return rows.length > 0;
    },

    async saveRecord(scope, record) {
      await withTenantDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ settings: settingsPatch(record) })
          .where(workspaceRow(scope)),
      );
    },

    async pullRequestState(scope, number) {
      const host = steeringHost();
      const repo = await host.resolveRepository(scope);
      const pr = await host.getPullRequest(repo, number);
      return { open: pr.open, merged: pr.merged };
    },

    async serverFolders(scope) {
      const host = steeringHost();
      const repo = await host.resolveRepository(scope);
      return serverFolderNames(
        await host.listFiles(repo, repo.defaultBranch, TOOL_SERVERS_DIR),
      );
    },

    async migrate(scope, args) {
      const opener = registeredOpener();
      // The run records each PR before migrate() marks its rows, so a retry
      // finds the PR even when a later batch fails.
      const recording: SteeringPrOpener = {
        hasSteeringRepo: (s) => opener.hasSteeringRepo(s),
        readFile: (s, path) => opener.readFile(s, path),
        async open(request) {
          const pr = await opener.open(request);
          await args.onOpened(pr);
          return pr;
        },
      };
      const { migrate } = await import("./migrate");
      const { opened, plan } = await migrate(scope, {
        opener: recording,
        existingFolders: args.existingFolders,
        actorUserId: args.actorUserId,
      });
      return {
        opened,
        movedServerIds: plan.batches.flatMap((batch) =>
          batch.folders.map((folder) => folder.serverId),
        ),
        notMoved: plan.notMoved,
      };
    },
  };
}
