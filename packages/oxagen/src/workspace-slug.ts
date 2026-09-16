// The one shape a workspace slug has to hold, wherever a surface sets one.
//
// A workspace is addressed at `/{org}/{slug}`, so its slug is a route segment
// of the organization's namespace and is subject to two rules that used to be
// written out per contract, differently:
//
//   1. It may not take a segment the organization's own pages already own.
//      `create_org` refused a reserved first-workspace slug; `create_workspace`
//      and `update_workspace_settings` did not, so `roles`, `api-keys` and
//      `billing` were accepted as slugs and shadowed `/{org}/roles` and the
//      rest.
//   2. It has ONE spelling. `create_workspace` took `^[a-z0-9-]+$`, which
//      accepts `team--one` and `team-`; `update_workspace_settings` took
//      `^[a-z0-9]+(?:-[a-z0-9]+)*$`, which does not. A workspace created with
//      either spelling could never be edited again, because every later edit
//      resubmits the stored slug to the stricter validator and is refused a
//      field the user did not touch.
//
// Both rules now live here, and every contract that accepts a workspace slug
// takes `workspaceSlug`. A third divergence cannot be introduced by writing a
// regex in a fourth place, because there is nowhere to write it.
import { z } from "zod";

/**
 * Org-level route segments a workspace slug may not take: a workspace at
 * `/{org}/{slug}` would shadow `/{org}/<segment>`. The set is the union of the
 * rev1 org pages (`api-keys`, `billing`, `audit`) and the org sections of
 * `apps/app_deprecated`, which serves production until cutover.
 */
export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  "access",
  "api-keys",
  "audit",
  "billing",
  "dashboard",
  "developer",
  "governance",
  "members",
  "new-workspace",
  "register",
  "roles",
  "security",
  "settings",
  "workspaces",
]);

/**
 * Lowercase letters and digits in groups separated by single hyphens: no
 * leading hyphen, no trailing hyphen, no doubled hyphen. The stricter of the
 * two spellings that were in the tree, because the looser one admitted slugs
 * the stricter one then locked out of every subsequent edit.
 */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const WORKSPACE_SLUG_MIN = 2;
export const WORKSPACE_SLUG_MAX = 40;

/** The shape every contract field that accepts a workspace slug is built from. */
export const workspaceSlug = z
  .string()
  .min(WORKSPACE_SLUG_MIN)
  .max(WORKSPACE_SLUG_MAX)
  .regex(
    WORKSPACE_SLUG_PATTERN,
    "lowercase letters and digits, separated by single hyphens",
  )
  .refine((s) => !RESERVED_WORKSPACE_SLUGS.has(s), {
    message: "workspace slug is a reserved route segment",
  });
