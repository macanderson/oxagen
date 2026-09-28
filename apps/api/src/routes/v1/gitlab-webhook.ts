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
 * Provisioning registers a second kind of hook on each GitLab steering project
 * (#4562), at `POST /webhooks/gitlab/steering/:scopeKind/:scopeId`. Its
 * token is an HMAC of the scope and the project, and
 * `@oxagen/handlers/gitlab.steering-webhook` checks it and turns a push or a
 * merge into a health check and a steering sync.
 */
import { Hono } from "hono";
import {
  gitlabSteeringWebhookDeps,
  handleGitLabSteeringWebhook,
} from "@oxagen/handlers/gitlab.steering-webhook";
import {
  gitlabWebhookDeps,
  handleGitLabWebhook,
} from "@oxagen/handlers/gitlab.webhook";
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

gitlabWebhookRoute.post("/steering/:scopeKind/:scopeId", async (c) => {
  const result = await handleGitLabSteeringWebhook(
    gitlabSteeringWebhookDeps(),
    {
      scopeKind: c.req.param("scopeKind"),
      scopeId: c.req.param("scopeId"),
      tokenHeader: c.req.header("x-gitlab-token") ?? null,
      body: await jsonBody(c.req),
    },
  );
  return c.json({ outcome: result.outcome }, result.status);
});

gitlabWebhookRoute.post("/:connectionId", async (c) => {
  const body = await jsonBody(c.req);
  const result = await handleGitLabWebhook(gitlabWebhookDeps(), {
    connectionPublicId: c.req.param("connectionId"),
    tokenHeader: c.req.header("x-gitlab-token") ?? null,
    body,
  });
  return c.json({ outcome: result.outcome }, result.status);
});
