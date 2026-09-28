// published.ts: the workspace's published steering version, as the served
// tools read it (lane M15; mcp-studio-spec, Call path).
//
// The version is the one the steering repo's publisher last pointed the
// workspace at. Its tools are the compiled tool manifest, its policies are
// the files under policy/, and its agents are the agent/v1 files. S5b's
// TachoPublished reads the same pointer for the host bundle (#4550). When
// that reader lands, this file can read through it.
import { toolManifestSchema } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { repoRef } from "@oxagen/oxagen/steering-repo/names";
import type { PublishedTools } from "./types";

/** The steering repository a workspace connected, as the connection reader returns it. */
export interface SteeringConnectionRead {
  provider?: "github" | "gitlab";
  source: string;
  owner: string;
  repo: string;
  approvedFullName?: string;
}

/**
 * The key the publisher stores a repository's versions under:
 * <host>/<owner>/<name>, from the name the binding recorded. It mirrors
 * steeringRepositoryKey in packages/handlers/src/steering-repo/publisher.ts.
 */
export function steeringKey(connection: SteeringConnectionRead): string {
  const fullName =
    connection.source === "binding" && connection.approvedFullName !== undefined
      ? connection.approvedFullName
      : `${connection.owner}/${connection.repo}`;
  const cut = fullName.lastIndexOf("/");
  const host = connection.provider === "gitlab" ? "gitlab.com" : "github.com";
  return repoRef(host, fullName.slice(0, cut), fullName.slice(cut + 1));
}

/**
 * The served tools of one published version. A version with no workspace
 * slug belongs to an organization repository, which serves no tool here.
 * A manifest that does not parse serves no tool, and the caller logs why.
 */
export function publishedTools(bundle: Bundle): PublishedTools | null {
  if (bundle.workspace === undefined) return null;
  const manifest = bundle.tools === null ? null : toolManifestSchema.parse(bundle.tools);
  return {
    repository: bundle.repository,
    workspace: bundle.workspace,
    version: bundle.version,
    manifest,
    policies: bundle.policies === null ? null : bundle.policies.policies.map(({ path, text }) => ({ path, text })),
    agents: bundle.agents.map(({ name, operator, runtime, harness }) => ({ name, operator, runtime, harness })),
  };
}

/** Where the loader reads from. Production binds the handlers' readers. */
export interface PublishedSources {
  connection(scope: { orgId: string; workspaceId: string }): Promise<SteeringConnectionRead | null>;
  current(scope: { orgId: string; workspaceId: string }, repository: string): Promise<Bundle | null>;
}

/** The workspace's published tools, or null when it connected no steering repo or published nothing. */
export async function loadPublished(
  sources: PublishedSources,
  scope: { orgId: string; workspaceId: string },
): Promise<PublishedTools | null> {
  const connection = await sources.connection(scope);
  if (connection === null) return null;
  const bundle = await sources.current(scope, steeringKey(connection));
  return bundle === null ? null : publishedTools(bundle);
}
