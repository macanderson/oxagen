/**
 * `get_published_steering`: the published `.oxagen/` tree, with every file's text, for
 * `oxagen pull` to write into a directory on a developer's machine.
 *
 * Steering is published by merging a Context PR onto the main repository's
 * production branch (ADR-061), so what is in force is whatever that branch
 * holds under `.oxagen/` now. This read returns it from GitHub through the
 * workspace's own App installation at the moment of the call, at one commit:
 * every file is read at `head`, so a push landing mid-read cannot mix two
 * commits into one answer. A machine does not need git access to the main
 * repository to receive its workspace's steering.
 *
 * `bindingId` picks a repository; omitted, the workspace's main repository
 * answers, because that is the one whose `.oxagen/` steers the workspace.
 * `.oxagen/workspace.json` is never returned: it is a machine's link and is
 * gitignored.
 *
 * Refusals: `conflict: main_repo_unbound` (no bindingId and no main
 * repository), `not_found: repository_not_linked`, `conflict:
 * github_not_connected`, `not_found: repository_not_installed`, `conflict:
 * repository_host_unsupported`, and `conflict: steering_too_large` when the
 * tree holds more than `PUBLISHED_STEERING_MAX_FILES` files.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryMainBind } from "./repository.main.bind";
import { repositoryRole } from "./repository.list";

/** The most files one pull returns. A tree past this is refused, not cut. */
export const PUBLISHED_STEERING_MAX_FILES = 500;

export const publishedSteeringGet = registerCapability({
  name: "get_published_steering",
  domain: "context",
  description:
    "Read the published .oxagen/ tree of the workspace's main repository (or a named one) at its production branch head, with every file's text, so a machine can write the steering in force.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId.optional(),
    })
    .strict(),
  output: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId,
      role: repositoryRole,
      fullName: z.string().min(1),
      productionBranch: z.string().min(1),
      /** The production branch's head commit; null when the branch is gone. */
      head: z.string().nullable(),
      files: z.array(
        z
          .object({
            /** Repository-relative, always under `.oxagen/`. */
            path: z.string().min(1),
            content: z.string(),
          })
          .strict(),
      ),
      readAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type PublishedSteeringGetInput = z.output<
  typeof publishedSteeringGet.input
>;
export type PublishedSteeringGetOutput = z.output<
  typeof publishedSteeringGet.output
>;
