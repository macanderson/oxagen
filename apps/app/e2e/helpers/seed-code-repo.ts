/**
 * seed-code-repo.ts — DB helper to seed a `connected` GitHub connection with a
 * resolvable owner/repo, so e2e specs can exercise the chat composer's code-mode
 * repo picker without a real GitHub OAuth flow. Mirrors seed-subscription.ts's
 * pattern: a fresh `postgres` client (not drizzle) so the seed works standalone
 * from the Playwright process.
 *
 * Every workspace already gets a seeded "Default" environment at creation time
 * (packages/handlers/src/workspace-environment-seed.ts, wired into both
 * new-organization and new-workspace actions) — this helper resolves its
 * publicId rather than inserting a second one (workspaces allow exactly one
 * `is_default` environment).
 */
import postgres from "postgres";

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

export interface SeedGithubRepoOpts {
  orgSlug: string;
  workspaceSlug?: string;
  owner?: string;
  repo?: string;
  defaultBranch?: string;
}

export interface SeededGithubRepo {
  /** publicId of the `ingestion.source_connections` row — code.connectionId. */
  connectionId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** publicId of the workspace's default `environments.environments` row. */
  environmentId: string;
  /** Removes the seeded connection row. The default environment is left alone. */
  cleanup: () => Promise<void>;
}

/**
 * Seeds a `connected` GitHub connection whose deliveryConfig resolves to a
 * single usable repo (the `{ owner, repo, defaultBranch }` shape written by
 * connection.mappings.set — see _shared/code-mode-data.ts's parseRepoEntries).
 */
export async function seedConnectedGithubRepo(
  opts: SeedGithubRepoOpts,
): Promise<SeededGithubRepo> {
  const {
    orgSlug,
    workspaceSlug = "default",
    owner = "oxageninc",
    repo = "e2e-fixture-repo",
    defaultBranch = "main",
  } = opts;

  const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
  try {
    const [org] = await sql<{ id: string }[]>`
      SELECT id FROM org.organizations WHERE slug = ${orgSlug} LIMIT 1
    `;
    if (!org)
      throw new Error(`seed-code-repo: org not found for slug "${orgSlug}"`);

    const [workspace] = await sql<{ id: string }[]>`
      SELECT id FROM workspace.workspaces WHERE org_id = ${org.id} AND slug = ${workspaceSlug} LIMIT 1
    `;
    if (!workspace) {
      throw new Error(
        `seed-code-repo: workspace not found for slug "${workspaceSlug}" in org "${orgSlug}"`,
      );
    }

    const publicId = `con_e2e_${Math.random().toString(36).slice(2, 10)}`;
    const deliveryConfig = JSON.stringify({ owner, repo, defaultBranch });

    const [conn] = await sql<{ public_id: string }[]>`
      INSERT INTO ingestion.source_connections (
        public_id, org_id, workspace_id, connector_id, display_name,
        auth_scheme, delivery_method, delivery_config, status, health_status
      ) VALUES (
        ${publicId}, ${org.id}, ${workspace.id}, 'github', 'GitHub',
        'oauth2_authorization_code', 'webhook', ${deliveryConfig}::jsonb,
        'connected', 'healthy'
      )
      RETURNING public_id
    `;
    if (!conn)
      throw new Error("seed-code-repo: connection insert returned no row");

    const [env] = await sql<{ public_id: string }[]>`
      SELECT public_id FROM environments.environments
      WHERE workspace_id = ${workspace.id} AND is_default = true
      LIMIT 1
    `;
    if (!env) {
      throw new Error(
        "seed-code-repo: no default environment found for workspace — workspace-environment-seed may not have run",
      );
    }

    const cleanup = async () => {
      const cleanSql = postgres(DATABASE_URL, { max: 1, prepare: false });
      try {
        await cleanSql`DELETE FROM ingestion.source_connections WHERE public_id = ${publicId}`;
      } finally {
        await cleanSql.end({ timeout: 5 });
      }
    };

    return {
      connectionId: conn.public_id,
      owner,
      repo,
      defaultBranch,
      environmentId: env.public_id,
      cleanup,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
