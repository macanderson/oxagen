// steering-hook.ts: the project hook Oxagen registers on a GitLab steering
// project, and the token that proves a delivery came through it (lane S8,
// #4562).
//
// Oxagen stores nothing about the hook. The token is an HMAC of the scope and
// the project under BETTER_AUTH_SECRET, so the receiver recomputes it from the
// steering repo state it already reads. Every provisioning run writes the
// current token onto the hook. After the secret rotates, a GitLab steering
// project's deliveries answer 401 until provisioning runs for it again.
import { createHmac } from "node:crypto";
import { apiPublicOrigin } from "@oxagen/config/api-origin";
import { requireEnv } from "@oxagen/config/env";

/** Separates this token from every other HMAC made with the same secret. */
export const STEERING_HOOK_DOMAIN = "oxagen.gitlab-steering-hook.v1";

/** Whose steering project a hook belongs to. */
export type SteeringHookScopeKind = "workspace" | "organization";

/** Whether a path segment names a scope kind. */
export function isSteeringHookScopeKind(
  value: string,
): value is SteeringHookScopeKind {
  return value === "workspace" || value === "organization";
}

/** The steering project a hook serves. */
export interface SteeringHookIdentity {
  kind: SteeringHookScopeKind;
  /** The workspace id, or the organization id for `<org>/oxagen-config`. */
  scopeId: string;
  /** GitLab's project id. */
  projectId: number;
}

/** The API path a steering hook calls. The API mounts it under its origin. */
export function steeringHookPath(
  kind: SteeringHookScopeKind,
  scopeId: string,
): string {
  return `/webhooks/gitlab/steering/${kind}/${scopeId}`;
}

/**
 * The secret token GitLab sends in `X-Gitlab-Token`. It binds the scope and
 * the project, so a hook copied onto another project, or a token read from
 * one scope's hook, does not authenticate anywhere else.
 */
export function steeringHookToken(
  secret: string,
  identity: SteeringHookIdentity,
): string {
  return createHmac("sha256", secret)
    .update(
      [
        STEERING_HOOK_DOMAIN,
        identity.kind,
        identity.scopeId,
        String(identity.projectId),
      ].join("\n"),
    )
    .digest("base64url");
}

/** What a provisioning run writes onto the project hook. */
export interface SteeringHookTarget {
  url: string;
  token: string;
}

/**
 * The hook's URL and token. The secret is read here, when a run needs it, so
 * importing this module never requires it.
 */
export function steeringHookTarget(
  identity: SteeringHookIdentity,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SteeringHookTarget {
  const { BETTER_AUTH_SECRET } = requireEnv(
    ["BETTER_AUTH_SECRET"] as const,
    env as NodeJS.ProcessEnv,
  );
  return {
    url: `${apiPublicOrigin(env)}${steeringHookPath(identity.kind, identity.scopeId)}`,
    token: steeringHookToken(BETTER_AUTH_SECRET, identity),
  };
}
