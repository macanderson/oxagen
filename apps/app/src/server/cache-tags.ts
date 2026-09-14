// Cache tags: the one place a tag string is built (plan §4.7, "Caching
// slow-moving reads"). A cached read calls `cacheTag(tags.tools(scope))`; the
// write that changes it calls `updateTag(tags.tools(scope))` for read-your-writes.
//
// Tags carry the tenant id, so one organization's write never invalidates
// another's cache entry. A workspace tag built from an organization-only scope
// would carry the shared sentinel id and invalidate every organization's entry
// at once, so it throws instead.
import { CacheTagScopeError } from "./errors";
import { isOrgOnlyScope, type Scope } from "./tenant-scope";

/** Next caps a tag at 256 characters; ids are UUIDs and public ids, far below it. */
const MAX_TAG_LENGTH = 256;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function segment(kind: string, value: string): string {
  if (!SEGMENT.test(value)) {
    throw new CacheTagScopeError(
      `cache tag ${kind} must be a non-empty id without separators, got ${JSON.stringify(value.slice(0, 40))}`,
    );
  }
  return value;
}

function build(parts: readonly string[]): string {
  const tag = parts.join(":");
  if (tag.length > MAX_TAG_LENGTH) {
    throw new CacheTagScopeError(
      `cache tag exceeds ${String(MAX_TAG_LENGTH)} characters`,
    );
  }
  return tag;
}

function ws(scope: Scope, ...rest: string[]): string {
  if (isOrgOnlyScope(scope)) {
    throw new CacheTagScopeError(
      `workspace cache tag "${rest[0] ?? ""}" needs a workspace scope, not the organization-only sentinel`,
    );
  }
  return build(["ws", segment("workspaceId", scope.workspaceId), ...rest]);
}

function org(scope: Scope, name: string): string {
  return build(["org", segment("orgId", scope.orgId), name]);
}

export const tags = {
  // Workspace pages
  runs: (scope: Scope) => ws(scope, "runs"),
  run: (scope: Scope, runId: string) =>
    ws(scope, "run", segment("runId", runId)),
  approvals: (scope: Scope) => ws(scope, "approvals"),
  agents: (scope: Scope) => ws(scope, "agents"),
  agent: (scope: Scope, agentKey: string) =>
    ws(scope, "agent", segment("agentKey", agentKey)),
  tools: (scope: Scope) => ws(scope, "tools"),
  ontology: (scope: Scope) => ws(scope, "ontology"),
  steering: (scope: Scope) => ws(scope, "steering"),
  spend: (scope: Scope) => ws(scope, "spend"),
  budgets: (scope: Scope) => ws(scope, "budgets"),
  // Organization pages
  organization: (scope: Scope) => org(scope, "organization"),
  members: (scope: Scope) => org(scope, "members"),
  workspaces: (scope: Scope) => org(scope, "workspaces"),
  roles: (scope: Scope) => org(scope, "roles"),
  apiKeys: (scope: Scope) => org(scope, "api-keys"),
  billing: (scope: Scope) => org(scope, "billing"),
  audit: (scope: Scope) => org(scope, "audit"),
  // Per person, across organizations
  notifications: (userId: string) =>
    build(["user", segment("userId", userId), "notifications"]),
} as const;

export type CacheTagName = keyof typeof tags;
