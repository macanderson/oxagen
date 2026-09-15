// The shell's view model (ARCHITECTURE.md §3.3): the organizations the viewer
// belongs to and the workspaces of the current organization the viewer is a
// member of, for the organization and workspace switchers.
import { z } from "zod";

export const OrgChoice = z.object({
  slug: z.string().min(1),
  name: z.string(),
});

export const WorkspaceChoice = z.object({
  slug: z.string().min(1),
  name: z.string(),
});

export const ShellContext = z.object({
  orgs: z.array(OrgChoice),
  workspaces: z.array(WorkspaceChoice),
});
export type ShellContext = z.infer<typeof ShellContext>;
