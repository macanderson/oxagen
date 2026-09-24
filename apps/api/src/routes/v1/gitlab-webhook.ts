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
 */
import { Hono } from "hono";
import {
  gitlabWebhookDeps,
  handleGitLabWebhook,
} from "@oxagen/handlers/gitlab.webhook";
import type { AppEnv } from "../../app";

export const gitlabWebhookRoute = new Hono<AppEnv>();

gitlabWebhookRoute.post("/:connectionId", async (c) => {
  const raw = await c.req.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Left null: the handler authenticates first and then answers
    // `ignored_unparseable`, the same as any body it cannot read.
  }
  const result = await handleGitLabWebhook(gitlabWebhookDeps(), {
    connectionPublicId: c.req.param("connectionId"),
    tokenHeader: c.req.header("x-gitlab-token") ?? null,
    body,
  });
  return c.json({ outcome: result.outcome }, result.status);
});
