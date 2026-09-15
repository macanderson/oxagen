// The typed list of reads a page may make (ARCHITECTURE.md §3.3). Every method
// takes the viewer's ctx and returns a `Read<T>`, and every method has a
// production caller (INV-17). The rev1 ports land with the seams and pages
// that bind them: `pretenant` in WL-12, and the Fleet, Run, Organization and
// Billing ports in WL-34 to WL-38.
import type { OrgCtx } from "@/server/viewer";
import type { ShellContext } from "./contracts/shell";
import type { Read } from "./read";

export interface DataSource {
  /** list_orgs + list_workspaces; caller: features/shell/source.ts. */
  shell: { context(ctx: OrgCtx): Promise<Read<ShellContext>> };
}
