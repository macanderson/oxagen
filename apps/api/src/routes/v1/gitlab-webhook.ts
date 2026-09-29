/**
 * GitLab project webhook receiver (#3762).
 *
 * `attach_gitlab_project` registers one hook per connected project at
 * `POST /webhooks/gitlab/:connectionId`, with a secret token GitLab echoes in
 * `X-Gitlab-Token`. This route is a thin adapter: the authentication, the
 * re-read of the merge request through the GitLab API, and every write live in
 * `@oxagen/handlers/gitlab.webhook`, which explains why duplicate and
 * out-of-order deliveries are harmless there.
 *
 * The body is parsed only after the handler has authenticated the delivery, so
 * an unauthenticated caller learns nothing from a malformed body either.
 *
 * The route also binds the steering repo health request (S2, #4560). A push to
 * main, a merge request with a new head, or a project setting change asks for
 * one health read per scope that holds the project as its steering repo. The
 * handler logs a failure to ask and answers the delivery as before.
 *
 * Provisioning registers a second kind of hook on each GitLab steering project
 * (#4562), at `POST /webhooks/gitlab/steering/:scopeKind/:scopeId`. Its
 * token is an HMAC of the scope and the project, and
 * `@oxagen/handlers/gitlab.steering-webhook` checks it and turns a push or a
 * merge into a health check and a steering sync. The route binds that health
 * check too. The handler has already matched the hook to one scope, so the
 * request goes to that scope without a lookup.
 */
import { Hono } from "hono";
import {
  gitlabSteeringWebhookDeps,
  handleGitLabSteeringWebhook,
  type SteeringHookReason,
  type SteeringHookScope,
} from "@oxagen/handlers/gitlab.steering-webhook";
import {
  gitlabWebhookDeps,
  handleGitLabWebhook,
} from "@oxagen/handlers/gitlab.webhook";
import {
  findHealthScopes,
  healthRequests,
  type HealthSignal,
} from "@oxagen/handlers/steering-repo/health";
import {
  routeGitlabDiscoveryPush,
  type GitlabProject,
} from "@oxagen/handlers/mcp-studio/discovery/webhook";
import { eventClient } from "../../event-client";
import { logger } from "../../middleware/logger";
import type { AppEnv } from "../../app";

export const gitlabWebhookRoute = new Hono<AppEnv>();

/**
 * The delivery's body as JSON, or null when it does not parse. Null goes to
 * the handler, which authenticates first and then answers
 * `ignored_unparseable`, the same as any body it cannot read.
 */
async function jsonBody(req: { text(): Promise<string> }): Promise<unknown> {
  const raw = await req.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Send one health request per scope whose steering repo the signal names. */
async function requestHealthCheck(signal: HealthSignal): Promise<void> {
  const scopes = await findHealthScopes(signal);
  if (scopes.length === 0) return;
  await eventClient.send(
    healthRequests(scopes, signal.trigger).map((r) => ({
      name: r.name,
      data: { ...r.data },
    })),
  );
}

/**
 * Send one health request for the scope a steering project hook belongs to.
 * A project hook names no actor, time, or setting, so the trigger carries the
 * reason alone.
 */
async function requestSteeringHealthCheck(
  scope: SteeringHookScope,
  reason: SteeringHookReason,
): Promise<void> {
  const trigger = {
    reason,
    actor: null,
    at: null,
    settings: [],
    pull_request: null,
  };
  await eventClient.send(
    healthRequests([scope], trigger).map((r) => ({
      name: r.name,
      data: { ...r.data },
    })),
  );
}

gitlabWebhookRoute.post("/steering/:scopeKind/:scopeId", async (c) => {
  const result = await handleGitLabSteeringWebhook(
    {
      ...gitlabSteeringWebhookDeps(),
      requestHealthCheck: requestSteeringHealthCheck,
    },
    {
      scopeKind: c.req.param("scopeKind"),
      scopeId: c.req.param("scopeId"),
      tokenHeader: c.req.header("x-gitlab-token") ?? null,
      body: await jsonBody(c.req),
    },
  );
  return c.json({ outcome: result.outcome }, result.status);
});

/** Outcomes that say the delivery is not a verified push to this project. */
const UNVERIFIED_OUTCOMES: ReadonlySet<string> = new Set([
  "unauthenticated",
  "ignored_unparseable",
  "ignored_other_project",
]);

/**
 * Ask for the discovery of every on-change MCP server whose definition a
 * verified push changed (lane M10, #4682). The push speaks only for the
 * project of the connection that authenticated it. It logs a failure and
 * never throws: the server's next discovery reads the definition anyway.
 */
async function requestDefinitionDiscovery(
  outcome: string,
  body: unknown,
  project: GitlabProject | null,
): Promise<void> {
  if (project === null || UNVERIFIED_OUTCOMES.has(outcome)) return;
  try {
    await routeGitlabDiscoveryPush(body, project);
  } catch (err) {
    logger.error(
      { err },
      "GitLab webhook: could not request an MCP server discovery; the server's next scheduled discovery will read the definition",
    );
  }
}

gitlabWebhookRoute.post("/:connectionId", async (c) => {
  const body = await jsonBody(c.req);
  const base = gitlabWebhookDeps();
  // The connection's project, kept for the discovery request below.
  const seen: { project: GitlabProject | null } = { project: null };
  const deps = {
    ...base,
    requestHealthCheck,
    async findConnection(publicId: string) {
      const connection = await base.findConnection(publicId);
      seen.project =
        connection === null
          ? null
          : { id: connection.projectId, path: connection.projectPath };
      return connection;
    },
  };
  const result = await handleGitLabWebhook(deps, {
    connectionPublicId: c.req.param("connectionId"),
    tokenHeader: c.req.header("x-gitlab-token") ?? null,
    body,
  });
  await requestDefinitionDiscovery(result.outcome, body, seen.project);
  return c.json({ outcome: result.outcome }, result.status);
});
