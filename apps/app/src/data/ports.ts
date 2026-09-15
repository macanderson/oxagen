// The typed list of reads a page may make (ARCHITECTURE.md §3.3). Every method
// takes the viewer's ctx and returns a `Read<T>`, and every method has a
// production caller (INV-17). The rev1 ports land with the seams and pages
// that bind them: the Fleet, Run, Organization and Billing ports in WL-34 to
// WL-38.
import type { OrgCtx, PretenantCtx } from "@/server/viewer";
import type {
  OrgChoice,
  ShellContext,
  WorkspaceChoice,
} from "./contracts/shell";
import type { Read } from "./read";

export interface DataSource {
  /**
   * list_orgs and list_workspaces ({orgSlug}) for a signed-in person before
   * any organization context; callers: features/shell/landing.ts and
   * features/auth/cli-consent.ts. The only
   * port that takes a PretenantCtx, so src/data/live/pretenant.ts is the only
   * caller of kernelRead's PretenantCtx overload.
   */
  pretenant: {
    orgs(ctx: PretenantCtx): Promise<Read<OrgChoice[]>>;
    workspaces(
      ctx: PretenantCtx,
      orgSlug: string,
    ): Promise<Read<WorkspaceChoice[]>>;
  };
  /** list_orgs + list_workspaces; caller: features/shell/source.ts. */
  shell: { context(ctx: OrgCtx): Promise<Read<ShellContext>> };
}
