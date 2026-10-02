// steering_repo.shared.ts: the shapes several steering repo contracts share.
//
// `create_workspace`, `get_steering_repo`, `list_steering_repo_destinations`,
// `retry_steering_repo_provision`, and `import_workspace_steering` all name a
// GitHub organization or GitLab group, and three of them take a repository
// name. They live here because `steering_repo.get` imports from
// `workspace.create`, so `workspace.create` cannot import from it.
import { z } from "zod";
import {
  defaultSteeringRepoName,
  isWorkspaceSteeringRepoName,
  ORGANIZATION_REPO_NAME,
} from "../steering-repo/names";

// The app may import platform code only under `@oxagen/oxagen/contracts/*`
// (INV-03), and the create forms show this name as the field's default.
export { defaultSteeringRepoName };

/**
 * A GitHub organization or a GitLab group the owner's tokens reach, which
 * setup could create steering repos in. `id` is the GitHub installation id or
 * the GitLab group id.
 */
export const steeringConnectionChoice = z.object({
  provider: z.enum(["github", "gitlab"]),
  id: z.number().int().positive(),
  name: z
    .string()
    .min(1)
    .describe(
      "The GitHub organization's or personal account's login, or the GitLab group's path.",
    ),
  kind: z
    .enum(["organization", "user"])
    .describe(
      "organization for a GitHub organization or GitLab group, user for the owner's own personal GitHub account.",
    ),
});

/**
 * A GitHub organization or GitLab group a person picks by provider and id. It
 * must be one `list_steering_repo_destinations` lists, or, after setup stopped
 * with `choose_connection`, one of `get_steering_repo`'s choices.
 */
export const steeringConnectionPick = z
  .object({
    provider: z.enum(["github", "gitlab"]),
    id: z.number().int().positive(),
  })
  .strict();

/**
 * The name a person gives a workspace's steering repo. It fits GitHub and
 * GitLab both, and it cannot be the organization's own `oxagen-config`.
 */
export const steeringRepoNameInput = z
  .string()
  .refine(isWorkspaceSteeringRepoName, {
    message: `Use up to 100 letters, digits, dots, underscores, and hyphens. Start and end with a letter or digit, put no two symbols in a row, and do not end with .git or .atom. ${ORGANIZATION_REPO_NAME} is the organization's own repository.`,
  })
  .describe(
    "The steering repo's name, such as oxagen-support. Oxagen creates exactly this name and stops with repository_name_taken when it is taken.",
  );
