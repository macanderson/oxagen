// lib/steering-app.ts: the names and credentials steering repositories use.
//
// The provisioner (`steering_repo.provision.ts`) creates a workspace's
// steering repository through the Oxagen GitHub App, or through a GitLab
// group access token, and binds it with a `source_connections` row whose
// `connector_id` names which one. A reader that later opens that steering
// head uses the installation that connection names, which can differ from
// the installation a workspace's code repositories use. Steering and code
// repositories share one GitHub App per deployment, read from GITHUB_APP_*
// (ADR-228). The names and the app's settings live here, in a module with no
// database or crypto import, so those readers can share them with the
// provisioner.
import { createAppInstallationToken } from "@oxagen/github";
import type { SteeringApp } from "@oxagen/github/provision";
import { HandlerError } from "@oxagen/oxagen";
import { OXAGEN_STEERING_APP } from "@oxagen/oxagen/steering-repo";

/**
 * The provider name for a GitHub steering connection. It is the
 * `oauth_accounts.provider` of the organization owner's user token from the
 * steering connect, and the `source_connections.connector_id` of the
 * connection a provisioned GitHub steering head hangs from. That connection's `delivery_config`
 * carries `{ installationId, owner }`.
 */
export const GITHUB_STEERING_PROVIDER = "github_steering";

/**
 * The provider name for a GitLab group access token that steering
 * repositories use. It is the `oauth_accounts.provider` of the stored token,
 * whose `provider_user_id` holds the group's numeric id, and the
 * `source_connections.connector_id` of the connection a provisioned GitLab
 * steering head hangs from. That connection's `delivery_config` carries
 * `{ groupId, groupPath }`.
 */
export const GITLAB_STEERING_PROVIDER = "gitlab_steering";

/** The refusal message when the deployment has no GitHub App settings. */
export const STEERING_APP_UNCONFIGURED_MESSAGE =
  "The Oxagen GitHub App is not configured on this deployment. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_SLUG.";

/**
 * The GitHub App's settings for steering repositories, or null when any is
 * unset. `symbol` stays the baseline's name for the app, and the provisioner
 * resolves it to this app's id.
 */
export function steeringAppFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { app: SteeringApp; privateKey: string } | null {
  const id = Number(env["GITHUB_APP_ID"]);
  const privateKey = env["GITHUB_APP_PRIVATE_KEY"];
  const slug = env["GITHUB_APP_SLUG"];
  if (!Number.isInteger(id) || id <= 0 || !privateKey || !slug) return null;
  return { app: { symbol: OXAGEN_STEERING_APP, id, slug }, privateKey };
}

/**
 * An installation token for the GitHub App on the installation a steering
 * connection names.
 * Refuses with `conflict: steering_app_unconfigured` when the deployment has
 * no app settings, the same reason the provisioner blocks on.
 */
export async function mintSteeringInstallationToken(
  installationId: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const config = steeringAppFromEnv(env);
  if (config === null)
    throw new HandlerError({
      code: "conflict",
      reason: "steering_app_unconfigured",
      message: STEERING_APP_UNCONFIGURED_MESSAGE,
    });
  const { token } = await createAppInstallationToken({
    appId: String(config.app.id),
    privateKey: config.privateKey,
    installationId,
  });
  return token;
}
