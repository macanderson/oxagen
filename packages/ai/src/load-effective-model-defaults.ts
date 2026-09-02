// Server-only helper — may import @oxagen/database.
// Queries user preferences and workspace model settings and resolves them into
// an effective ResolvedModelDefaults using the pure resolveModelDefaults().
//
// This is what the chat shell + stream route calls to get the effective model
// config for a session. It must not be imported by client components.

import { withTenantDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { resolveModelDefaults } from "./resolve-model-defaults";
import type {
  ResolvedModelDefaults,
  ModelDefaultsInput,
} from "./resolve-model-defaults";

export type { ResolvedModelDefaults, ModelDefaultsInput };

export interface LoadEffectiveModelDefaultsArgs {
  userId: string;
  /** Workspace id. Pass null when there is no workspace context. */
  workspaceId: string | null;
}

/**
 * Load user preferences + workspace model settings from the database and
 * return the resolved effective model defaults for the session.
 *
 * - Queries `auth.user_preferences` by `userId`.
 * - Queries `workspace.workspaces` by `workspaceId` (when provided).
 * - Delegates all precedence logic to `resolveModelDefaults()`.
 *
 * Server-only. Do not import in client components.
 */
export async function loadEffectiveModelDefaults(
  args: LoadEffectiveModelDefaultsArgs,
): Promise<ResolvedModelDefaults> {
  // Run both queries in parallel inside a single tenant-scoped transaction.
  const [userPrefsRow, workspaceRow] = await withTenantDb(async (tx) =>
    Promise.all([
      tx.query.userPreferences.findFirst({
        where: eq(schema.userPreferences.userId, args.userId),
        columns: {
          defaultTextTier: true,
          defaultTextModel: true,
          defaultImageModel: true,
          defaultVideoModel: true,
        },
      }),
      args.workspaceId
        ? tx.query.workspaces.findFirst({
            where: eq(schema.workspaces.id, args.workspaceId),
            columns: {
              defaultTextTier: true,
              defaultTextModel: true,
              defaultImageModel: true,
              defaultVideoModel: true,
            },
          })
        : Promise.resolve(null),
    ]),
  );

  const userInput: ModelDefaultsInput["user"] = userPrefsRow
    ? {
        defaultTextTier: userPrefsRow.defaultTextTier ?? null,
        defaultTextModel: userPrefsRow.defaultTextModel ?? null,
        defaultImageModel: userPrefsRow.defaultImageModel ?? null,
        defaultVideoModel: userPrefsRow.defaultVideoModel ?? null,
      }
    : null;

  const workspaceInput: ModelDefaultsInput["workspace"] = workspaceRow
    ? {
        defaultTextTier: workspaceRow.defaultTextTier ?? null,
        defaultTextModel: workspaceRow.defaultTextModel ?? null,
        defaultImageModel: workspaceRow.defaultImageModel ?? null,
        defaultVideoModel: workspaceRow.defaultVideoModel ?? null,
      }
    : null;

  return resolveModelDefaults({ user: userInput, workspace: workspaceInput });
}
