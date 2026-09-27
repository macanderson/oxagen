// lib/steering-app.ts: the Oxagen Steering app's names and credentials.
//
// The provisioner (`steering_repo.provision.ts`) creates a workspace's
// steering repository through the Oxagen Steering GitHub App, or through a
// GitLab group access token, and binds it with a `source_connections` row
// whose `connector_id` names which one. A reader that later opens that
// steering head has to use the same credential: the workspace's own GitHub
// App installation cannot see a repository only the Oxagen Steering app was
// added to. The names and the app's settings live here, in a module with no
// database or crypto import, so those readers can share them with the
// provisioner.
import { createAppInstallationToken } from "@oxagen/github";
import type { SteeringApp } from "@oxagen/github/provision";
import { HandlerError } from "@oxagen/oxagen";
import { OXAGEN_STEERING_APP } from "@oxagen/oxagen/steering-repo";

/**
 * The provider name for the Oxagen Steering GitHub App. It is the
 * `oauth_accounts.provider` of the owner's Oxagen Steering user token, and
 * the `source_connections.connector_id` of the connection a provisioned
 * GitHub steering head hangs from. That connection's `delivery_config`
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

/** The refusal message when the Oxagen Steering app has no settings. */
export const STEERING_APP_UNCONFIGURED_MESSAGE =
  "The Oxagen Steering app is not configured on this deployment. Set OXAGEN_STEERING_APP_ID, OXAGEN_STEERING_APP_PRIVATE_KEY, and OXAGEN_STEERING_APP_SLUG.";

/** The Oxagen Steering app's settings, or null when any is unset. */
export function steeringAppFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { app: SteeringApp; privateKey: string } | null {
  const id = Number(env["OXAGEN_STEERING_APP_ID"]);
  const privateKey = env["OXAGEN_STEERING_APP_PRIVATE_KEY"];
  const slug = env["OXAGEN_STEERING_APP_SLUG"];
  if (!Number.isInteger(id) || id <= 0 || !privateKey || !slug) return null;
  return { app: { symbol: OXAGEN_STEERING_APP, id, slug }, privateKey };
}

/**
 * An installation token for the Oxagen Steering app on one installation.
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
