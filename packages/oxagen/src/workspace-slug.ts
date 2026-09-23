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
//
// This module has no entry in the package's `exports` map, deliberately. It is
// reached from inside the package by relative import, and from `apps/app`
// through `contracts/org.create`, which re-exports the two names the
// onboarding form needs — because the app may import platform code only under
// `@oxagen/oxagen/contracts/*` (ARCHITECTURE.md §2, INV-03).
import { z } from "zod";

/**
 * Org-level route segments a workspace slug may not take: a workspace at
 * `/{org}/{slug}` would shadow `/{org}/<segment>`. The set is the union of the
 * rev1 org pages (`account`, `api-keys`, `billing`, `audit`, `roles`) and the org sections
 * of `apps/app_deprecated`.
 *
 * This set is enforced on the way IN. It does not repair rows already stored:
 * before #3110 neither `create_workspace` nor `update_workspace_settings`
 * consulted it, so an organization may hold a workspace slugged with one of
 * these. Where that segment is also a static route the workspace's ROOT url
 * opens the org page instead — its sub-pages still resolve, because the org
 * routes are leaf `page.tsx` files and only the root segment collides.
 * Re-slugging a stored workspace changes a customer's urls, so it is a
 * maintainer decision rather than a migration this validator can imply; see
 * the issue linked from PR #3110. `apps/app/src/shared/reserved-route-segments.test.ts`
 * is what stops a NEW org page taking an unreserved segment.
 */
export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  "access",
  "account",
  "api-keys",
  "audit",
  "billing",
  "dashboard",
  "developer",
  "governance",
  "members",
  "model-funding",
  "new-workspace",
  "register",
  "roles",
  "security",
  "settings",
  "sso",
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
