// The shell: the organization and workspace context behind the sidebar and
// switchers (spec §14.1). Spec vocabulary (spec §3, App. A), never the mockup's
// strings. Rev1 keeps the shell to this one read (ARCHITECTURE.md §1.2): no
// nav counts, bell, assistant, recent runs or Account dialog.
import { z } from "zod";
import { Count, Slug } from "./common";

// ---- Context ------------------------------------------------------------------

/** Where an organization's stores live (ADR-042, App. A `org.data_planes`). */
export const DataPlaneKind = z.enum(["shared", "dedicated"]);
export type DataPlaneKind = z.infer<typeof DataPlaneKind>;

export const ShellOrg = z.object({
  slug: Slug,
  name: z.string().min(1),
  /** The billing plan's display name, or null when the plan is not recorded. */
  plan: z.string().nullable(),
  dataPlane: DataPlaneKind,
  region: z.string().nullable(),
});
export type ShellOrg = z.infer<typeof ShellOrg>;

export const ShellWorkspace = z.object({
  slug: Slug,
  name: z.string().min(1),
  /** The workspace's one main repo (spec §3), e.g. `acme/platform`. */
  mainRepo: z.string().nullable(),
  productionBranch: z.string().nullable(),
  /** Registered agents, or null when not counted. Never an invented zero. */
  agentCount: Count.nullable(),
});
export type ShellWorkspace = z.infer<typeof ShellWorkspace>;

export const ShellViewer = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
});
export type ShellViewer = z.infer<typeof ShellViewer>;

export const ShellContext = z.object({
  viewer: ShellViewer,
  org: ShellOrg,
  /** Every organization the viewer belongs to, for the organization switcher. */
  orgs: z.array(ShellOrg.pick({ slug: true, name: true, plan: true })).min(1),
  workspaces: z.array(ShellWorkspace),
});
export type ShellContext = z.infer<typeof ShellContext>;
