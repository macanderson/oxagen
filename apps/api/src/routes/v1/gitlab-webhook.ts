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
 */
import { Hono } from "hono";
import {
  gitlabWebhookDeps,
  handleGitLabWebhook,
} from "@oxagen/handlers/gitlab.webhook";
import {
  findHealthScopes,
  healthRequests,
  type HealthSignal,
} from "@oxagen/handlers/steering-repo/health";
import { eventClient } from "../../event-client";
import type { AppEnv } from "../../app";

export const gitlabWebhookRoute = new Hono<AppEnv>();

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

gitlabWebhookRoute.post("/:connectionId", async (c) => {
  const raw = await c.req.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Left null: the handler authenticates first and then answers
    // `ignored_unparseable`, the same as any body it cannot read.
  }
  const deps = { ...gitlabWebhookDeps(), requestHealthCheck };
  const result = await handleGitLabWebhook(deps, {
    connectionPublicId: c.req.param("connectionId"),
    tokenHeader: c.req.header("x-gitlab-token") ?? null,
    body,
  });
  return c.json({ outcome: result.outcome }, result.status);
});
