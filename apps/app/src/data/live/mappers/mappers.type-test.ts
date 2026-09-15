// INV-08, the compile-time half (ARCHITECTURE.md §3.4). Compiled by the app's
// `tsc --noEmit`, never executed: each directive below must meet an error, or
// TS2578 fails the typecheck. A view field is nullable exactly when the
// contract field it copies is: the mapper's return type refuses a nullable
// source in a required field, and NullableOnlyWhenSourceIs refuses a required
// source in a nullable field. Every mapper's output is checked against it.
import type { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import type { runList } from "@oxagen/oxagen/contracts/run.list";
import type { ContractOutput } from "@/server/kernel";
import type { toApprovalItems } from "./approvals";
import type { toRunPage } from "./runs";

/** Each field of View that Out also has may be nullable only where Out's is. */
type NullableOnlyWhenSourceIs<View, Out> = {
  [K in keyof View]: K extends keyof Out
    ? null extends View[K]
      ? null extends Out[K]
        ? View[K]
        : never
      : View[K]
    : View[K];
};

type RunOut = ContractOutput<typeof runList>["runs"][number];
type RunView = ReturnType<typeof toRunPage>["runs"][number];
type ApprovalOut = ContractOutput<typeof agentApprovalList>["items"][number];
type ApprovalView = ReturnType<typeof toApprovalItems>[number];

declare const runOut: RunOut;
declare const runView: RunView;
declare const approvalView: ApprovalView;

// The positives: both mappers keep a field nullable only where the contract does.
const _runsHold: NullableOnlyWhenSourceIs<RunView, RunOut> = runView;
const _approvalsHold: NullableOnlyWhenSourceIs<ApprovalView, ApprovalOut> =
  approvalView;

// @ts-expect-error -- turns may be null on the contract, and frames is required on the view
const _nullableIntoRequired: Pick<RunView, "frames"> = { frames: runOut.turns };

type LoosenedRunView = Omit<RunView, "status"> & {
  status: RunView["status"] | null;
};
declare const loosened: LoosenedRunView;
// @ts-expect-error -- status is always recorded, so the view may not make it nullable
const _requiredIntoNullable: NullableOnlyWhenSourceIs<LoosenedRunView, RunOut> =
  loosened;
