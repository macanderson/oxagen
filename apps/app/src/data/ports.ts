// The typed list of reads a page may make (ARCHITECTURE.md §3.3). Every method
// takes the viewer's ctx and returns a `Read<T>`, and every method has a
// production caller (INV-17). The rev1 ports land with the seams and pages
// that bind them: the Fleet, Run and Organization ports in WL-34 to WL-37, the
// Billing port in WL-38.
import type { OrgCtx, PretenantCtx } from "@/server/viewer";
import type {
  ContractRate,
  GauBucket,
  InvoicePage,
  PlanCard,
} from "./contracts/billing";
import type { MemberList } from "./contracts/org";
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
  /**
   * The Billing page's four noBillingGate reads, each Owner, Admin or Billing
   * (checked in its handler); caller: features/billing/billing.tsx.
   */
  billing: {
    /** get_subscription */
    plan(ctx: OrgCtx): Promise<Read<PlanCard>>;
    /** get_gau_bucket: mode, meter, invoice thresholds, auto top-up state */
    bucket(ctx: OrgCtx): Promise<Read<GauBucket>>;
    /** get_contract_rate */
    contractRate(ctx: OrgCtx): Promise<Read<ContractRate>>;
    /** list_invoices, one cursor page, newest first */
    invoices(
      ctx: OrgCtx,
      q: { cursor: string | null },
    ): Promise<Read<InvoicePage>>;
  };
  /** list_members {scope:"org"}; caller: features/organization/people.tsx. */
  org: { members(ctx: OrgCtx): Promise<Read<MemberList>> };
}
