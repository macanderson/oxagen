// webhook.ts: a push that changes a definition asks for its server's
// discovery (lane M10, #4682; mcp-studio-spec, Sync).
//
// An OpenAPI, GraphQL, or gRPC server whose definition lives in a linked
// repository, and whose sync.schedule is on-change, is discovered again when
// a push to the definition's ref changes the definition's file. The GitHub
// App webhook and the GitLab project webhook hand the delivery's body here
// after they have authenticated it.
//
// A push names a repository, not a workspace, so the lookup reads every
// workspace's on-change servers in that repository. Each discovery then runs
// in its own workspace, with that workspace's credentials.
import { requestDiscoveries, type DiscoveryEntryDeps } from "./entry";
import { postgresDiscoverySweepStore, type OnChangeTarget } from "./store";

/** What one push changed, as both hosts report it. */
export interface DefinitionPush {
  /** github.com/owner/name or gitlab.com/group/name, lowercased. */
  repo: string;
  /** The pushed branch or tag name, such as main or v1.2.0. */
  name: string;
  /** The full ref, such as refs/heads/main. */
  ref: string;
  /** Every file the push's commits added, modified, or removed. */
  files: ReadonlySet<string>;
  /**
   * False when the payload may leave out a changed file: a force push, or a
   * push with more commits than the payload lists. Every definition on the
   * ref is discovered again then.
   */
  complete: boolean;
}

const ZERO_SHA = /^0+$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The name a ref points at: main for refs/heads/main, v1 for refs/tags/v1. */
function refName(ref: string): string | null {
  const match = /^refs\/(?:heads|tags)\/(.+)$/.exec(ref);
  return match?.[1] ?? null;
}

/** Every file the commits touched, and how many commits the payload lists. */
function changedFiles(commits: unknown): { files: Set<string>; count: number } {
  const files = new Set<string>();
  if (!Array.isArray(commits)) return { files, count: 0 };
  for (const commit of commits) {
    const c = record(commit);
    if (!c) continue;
    for (const field of ["added", "modified", "removed"] as const) {
      const list = c[field];
      if (!Array.isArray(list)) continue;
      for (const file of list) if (typeof file === "string") files.add(file);
    }
  }
  return { files, count: commits.length };
}

/**
 * A GitHub push delivery, or null when it deletes the ref or is not a push
 * this can read.
 */
export function githubDefinitionPush(body: unknown): DefinitionPush | null {
  const b = record(body);
  if (!b || b["deleted"] === true) return null;
  const ref = text(b["ref"]);
  const name = ref === null ? null : refName(ref);
  const fullName = text(record(b["repository"])?.["full_name"]);
  if (ref === null || name === null || fullName === null) return null;
  const { files } = changedFiles(b["commits"]);
  return {
    repo: `github.com/${fullName}`.toLowerCase(),
    name,
    ref,
    files,
    complete: b["forced"] !== true,
  };
}

/**
 * A GitLab push or tag push delivery, or null when it deletes the ref or is
 * not a push this can read. GitLab lists at most 20 commits and reports the
 * full count apart.
 */
export function gitlabDefinitionPush(body: unknown): DefinitionPush | null {
  const b = record(body);
  if (!b) return null;
  const kind = b["object_kind"];
  if (kind !== "push" && kind !== "tag_push") return null;
  const after = text(b["after"]);
  if (after === null || ZERO_SHA.test(after)) return null;
  const ref = text(b["ref"]);
  const name = ref === null ? null : refName(ref);
  const project = record(b["project"]);
  const path = text(project?.["path_with_namespace"]);
  const webUrl = text(project?.["web_url"]);
  if (ref === null || name === null || path === null || webUrl === null)
    return null;
  let host: string;
  try {
    host = new URL(webUrl).host;
  } catch {
    return null;
  }
  const { files, count } = changedFiles(b["commits"]);
  const total = b["total_commits_count"];
  return {
    repo: `${host}/${path}`.toLowerCase(),
    name,
    ref,
    files,
    complete: typeof total !== "number" || total <= count,
  };
}

/** The on-change targets a push reaches: its ref, and its definition's file. */
export function pushedTargets(
  push: DefinitionPush,
  targets: readonly OnChangeTarget[],
): OnChangeTarget[] {
  return targets.filter(
    (target) =>
      (target.ref === push.name || target.ref === push.ref) &&
      (!push.complete || push.files.has(target.path)),
  );
}

/** The store reads and the event sender a push route uses. */
export type DiscoveryPushDeps = DiscoveryEntryDeps;

async function route(
  push: DefinitionPush | null,
  deps: DiscoveryPushDeps,
): Promise<number> {
  if (push === null) return 0;
  const sweep = deps.sweep ?? postgresDiscoverySweepStore;
  const targets = pushedTargets(push, await sweep.onChangeByRepo(push.repo));
  if (targets.length === 0) return 0;
  return requestDiscoveries(
    targets.map(({ scope, server }) => ({ scope, server })),
    "push",
    deps,
  );
}

/**
 * Ask for a discovery of every on-change server whose definition a GitHub
 * push changed. Returns how many it asked for.
 */
export function routeGithubDiscoveryPush(
  body: unknown,
  deps: DiscoveryPushDeps = {},
): Promise<number> {
  return route(githubDefinitionPush(body), deps);
}

/**
 * Ask for a discovery of every on-change server whose definition a GitLab
 * push changed. Returns how many it asked for.
 */
export function routeGitlabDiscoveryPush(
  body: unknown,
  deps: DiscoveryPushDeps = {},
): Promise<number> {
  return route(gitlabDefinitionPush(body), deps);
}
