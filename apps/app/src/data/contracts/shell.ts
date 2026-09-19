// Organization and workspace choices (ARCHITECTURE.md §3.3): the organizations
// the viewer belongs to and the workspaces of one organization the viewer is a
// member of, for the shell's switchers and the CLI consent picker.
import { z } from "zod";

export const OrgChoice = z.object({
  slug: z.string().min(1),
  name: z.string(),
});

export type OrgChoice = z.infer<typeof OrgChoice>;

export const WorkspaceChoice = z.object({
  slug: z.string().min(1),
  name: z.string(),
});
export type WorkspaceChoice = z.infer<typeof WorkspaceChoice>;

export const ShellContext = z.object({
  orgs: z.array(OrgChoice),
  workspaces: z.array(WorkspaceChoice),
});
export type ShellContext = z.infer<typeof ShellContext>;

/**
 * The person's own clock, read for the shell and for every page under it: the
 * IANA zone next-intl formats each date in. One field today; the other account
 * preferences join it here when a surface reads them.
 */
export const ViewerPreferences = z.object({
  timeZone: z.string().min(1),
});
export type ViewerPreferences = z.infer<typeof ViewerPreferences>;
