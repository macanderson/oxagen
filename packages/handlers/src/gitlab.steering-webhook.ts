// audit-exempt: a webhook receiver that acts for no signed-in person. It writes nothing itself. It asks for a health check and a repository sync, and neither is a privileged mutation a person makes.
// gitlab.steering-webhook.ts: what a delivery from a GitLab steering
// project's hook does (lane S8, #4562).
//
// Provisioning registers one project hook on each GitLab steering project, at
// `/webhooks/gitlab/steering/<workspace|organization>/<id>` (see
// `lib/steering-hook.ts`). The hook sends push and merge request events. This
// receiver turns them into two requests:
//
// - A health check (#4560) for a push to the default branch, which may be a
//   change nobody reviewed. A group hook, which only a group Owner can add,
//   also sends project and member events. This receiver maps those to a
//   health check too, so a later change that registers a group hook needs
//   no change here.
// - A repository sync (ADR-184) for a workspace, when a push to the default
//   branch or a merge can change the records in force. A merge sends both a
//   push and a merge request event, so a workspace gets two sync requests for
//   one merge. The sync reads the branch itself, so the second finds nothing
//   left to do.
//
// The token binds the scope and the project, and the receiver checks it
// against the project the scope's own steering repo state names. It never
// trusts the payload's project id. An unknown scope, a scope with no GitLab
// steering project, and a wrong or missing token all answer the same 401, so
// the route does not say which scopes exist. The check does not wait for the
// repo to be ready: the hook exists from step six of provisioning, and the
// health check decides what a repo still provisioning means.
//
// A request that fails is logged and never fails the delivery. GitLab retries
// a failed delivery and disables a hook that keeps failing, which would stop
// every later event. The sweeps catch what a lost request misses.
import { schema, withSystemDb } from "@oxagen/database";
import { requireEnv } from "@oxagen/config/env";
import { verifyGitLabWebhookToken } from "@oxagen/gitlab";
import { and, eq, isNull } from "drizzle-orm";
import { pushesDefaultBranch } from "./gitlab.webhook";
import {
  isSteeringHookScopeKind,
  steeringHookToken,
  type SteeringHookScopeKind,
} from "./lib/steering-hook";
import { logger } from "./logger";
import { readSteeringRepoState } from "./steering_repo.provision";

/**
 * Whose steering repo a delivery is for: a workspace's, or the
 * organization's with `workspaceId` null. The shape of `HealthScope` in #4560.
 */
export interface SteeringHookScope {
  orgId: string;
  workspaceId: string | null;
}

/** The steering project a scope's own state names. */
export interface SteeringHookProject {
  scope: SteeringHookScope;
  /** GitLab's project id, as provisioning recorded it. */
  projectId: number;
}

/** What each delivery asks a health check for. */
export type SteeringHookReason = "push" | "project" | "member";

export interface GitLabSteeringWebhookDeps {
  /**
   * The GitLab steering project the scope's `steering_repo` setting names, or
   * null when there is no such scope or its steering repo is not on GitLab.
   */
  findSteeringProject(
    kind: SteeringHookScopeKind,
    scopeId: string,
  ): Promise<SteeringHookProject | null>;
  /** The secret the hook's token is made with. */
  secret(): string;
  /**
   * Ask for a health read of the scope's steering repo (#4560). Absent until
   * that lane plugs in its function, and a delivery then asks for nothing.
   */
  requestHealthCheck?(
    scope: SteeringHookScope,
    reason: SteeringHookReason,
  ): Promise<void>;
  /** Ask for the workspace's repository sync (ADR-184). */
  requestSync?(
    scope: { orgId: string; workspaceId: string },
    reason: string,
  ): Promise<void>;
}

export interface GitLabSteeringWebhookRequest {
  scopeKind: string;
  scopeId: string;
  tokenHeader: string | null;
  body: unknown;
}

export type GitLabSteeringWebhookOutcome =
  | "unauthenticated"
  | "ignored_unparseable"
  | "ignored_other_project"
  | "ignored_event"
  | "health_requested"
  | "sync_requested";

export interface GitLabSteeringWebhookResult {
  status: 202 | 401;
  outcome: GitLabSteeringWebhookOutcome;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNAUTHENTICATED: GitLabSteeringWebhookResult = {
  status: 401,
  outcome: "unauthenticated",
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A GitLab id arrives as a JSON number. A decimal string is accepted too. */
function idOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * The project a delivery names, or null when it names none. A group member
 * event carries only the group, so it names no project.
 */
function deliveryProjectId(body: Json): number | null {
  const project = isObject(body["project"]) ? body["project"] : null;
  const attrs = isObject(body["object_attributes"])
    ? body["object_attributes"]
    : null;
  return (
    idOf(project?.["id"]) ??
    idOf(body["project_id"]) ??
    idOf(attrs?.["target_project_id"])
  );
}

/**
 * The health check a delivery asks for, or null. Push and merge request
 * events carry `object_kind`. Group hook events carry only `event_name`:
 * `project_create`, `project_rename` and the like for a project, and
 * `user_add_to_group` or `user_add_to_team` and the like for a member.
 */
function healthReasonOf(body: Json): SteeringHookReason | null {
  const objectKind =
    typeof body["object_kind"] === "string" ? body["object_kind"] : null;
  if (objectKind === "push")
    return pushesDefaultBranch(body) ? "push" : null;
  if (objectKind !== null) return null;
  const eventName =
    typeof body["event_name"] === "string" ? body["event_name"] : "";
  if (eventName.startsWith("project_")) return "project";
  if (eventName.startsWith("user_")) return "member";
  return null;
}

/** Whether a merge request event reports the merge request merged. */
function reportsMerge(body: Json): boolean {
  if (body["object_kind"] !== "merge_request") return false;
  const attrs = isObject(body["object_attributes"])
    ? body["object_attributes"]
    : null;
  return attrs?.["state"] === "merged";
}

export async function handleGitLabSteeringWebhook(
  deps: GitLabSteeringWebhookDeps,
  req: GitLabSteeringWebhookRequest,
): Promise<GitLabSteeringWebhookResult> {
  // A malformed id never reaches the uuid column, where it would throw and
  // answer 500 in place of the 401 every other stranger gets.
  if (!isSteeringHookScopeKind(req.scopeKind) || !UUID_RE.test(req.scopeId))
    return UNAUTHENTICATED;
  const kind = req.scopeKind;
  const project = await deps.findSteeringProject(kind, req.scopeId);
  if (project === null) return UNAUTHENTICATED;
  const expected = steeringHookToken(deps.secret(), {
    kind,
    scopeId: req.scopeId,
    projectId: project.projectId,
  });
  if (!verifyGitLabWebhookToken(req.tokenHeader, expected))
    return UNAUTHENTICATED;

  if (!isObject(req.body))
    return { status: 202, outcome: "ignored_unparseable" };
  const body = req.body;
  // A hook copied onto another project carries a token for this one, and
  // must not act on this scope.
  const named = deliveryProjectId(body);
  if (named !== null && named !== project.projectId)
    return { status: 202, outcome: "ignored_other_project" };

  const { scope } = project;
  const reason = healthReasonOf(body);
  const merged = reportsMerge(body);
  let outcome: GitLabSteeringWebhookOutcome = "ignored_event";

  if (reason !== null && deps.requestHealthCheck) {
    try {
      await deps.requestHealthCheck(scope, reason);
      outcome = "health_requested";
    } catch (err) {
      logger.error(
        { err, orgId: scope.orgId, workspaceId: scope.workspaceId, reason },
        "gitlab.steering-webhook: could not request a health check; the sweep will read the repo",
      );
    }
  }

  const workspaceId = scope.workspaceId;
  if (
    (reason === "push" || merged) &&
    workspaceId !== null &&
    deps.requestSync
  ) {
    const syncReason = merged ? "merge_request" : "push";
    try {
      await deps.requestSync({ orgId: scope.orgId, workspaceId }, syncReason);
      if (outcome === "ignored_event") outcome = "sync_requested";
    } catch (err) {
      logger.error(
        { err, orgId: scope.orgId, workspaceId, reason: syncReason },
        "gitlab.steering-webhook: could not request a steering sync; the scheduled sweep will run it",
      );
    }
  }

  return { status: 202, outcome };
}

/** The real dependencies: Postgres and the API's auth secret. */
export function gitlabSteeringWebhookDeps(): GitLabSteeringWebhookDeps {
  return {
    async findSteeringProject(kind, scopeId) {
      // tenancy: webhook lookup with no tenant scope yet; filtered by the
      // scope id from the hook's URL, and the caller verifies the delivery's
      // token against the project this row names before anything else runs.
      const row = await withSystemDb(async (tx) => {
        if (kind === "organization") {
          const [org] = await tx
            .select({
              orgId: schema.organizations.id,
              settings: schema.organizations.settings,
            })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, scopeId))
            .limit(1);
          return org ? { ...org, workspaceId: null } : null;
        }
        const [workspace] = await tx
          .select({
            orgId: schema.workspaces.orgId,
            workspaceId: schema.workspaces.id,
            settings: schema.workspaces.settings,
          })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.id, scopeId),
              isNull(schema.workspaces.archivedAt),
            ),
          )
          .limit(1);
        return workspace ?? null;
      });
      if (row === null) return null;
      const state = readSteeringRepoState(row.settings);
      if (
        state === null ||
        state.provider !== "gitlab" ||
        state.repository === null
      )
        return null;
      return {
        scope: { orgId: row.orgId, workspaceId: row.workspaceId },
        projectId: state.repository.id,
      };
    },
    secret: () =>
      requireEnv(["BETTER_AUTH_SECRET"] as const).BETTER_AUTH_SECRET,
    // requestHealthCheck is left out until #4560 lands its function.
    async requestSync(scope, reason) {
      const { requestSteeringSync } = await import(
        "./context.steering.sync.request"
      );
      await requestSteeringSync([scope], reason);
    },
  };
}
