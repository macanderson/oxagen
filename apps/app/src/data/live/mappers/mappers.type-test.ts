// INV-08, the compile-time half (ARCHITECTURE.md §3.4). Compiled by the app's
// `tsc --noEmit`, never executed: each directive below must meet an error, or
// TS2578 fails the typecheck. A view field is nullable exactly when the
// contract field it copies is: the mapper's return type refuses a nullable
// source in a required field, and NullableOnlyWhenSourceIs refuses a required
// source in a nullable field. Every mapper's output is checked against it.
import type { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import type { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import type { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import type { agentList } from "@oxagen/oxagen/contracts/agent.list";
import type { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import type { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import type { onboardingFirstFrameGet } from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import type { onboardingStateGet } from "@oxagen/oxagen/contracts/onboarding.state.get";
import type { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import type { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import type { runList } from "@oxagen/oxagen/contracts/run.list";
import type { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import type { ContractOutput } from "@/server/kernel";
import type { toAgentDetail, toAgentPage, toIncidentPage } from "./agents";
import type { toApprovalItems } from "./approvals";
import type { toMandateList } from "./mandates";
import type { toAuditPage } from "./audit";
import type { toFirstFrame, toOnboardingGate } from "./onboarding";
import type { toApiKeys, toRoleCatalog, toWorkspaceList } from "./org";
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

type AgentRowOut = ContractOutput<typeof agentList>["items"][number];
type AgentRowView = ReturnType<typeof toAgentPage>["agents"][number];
type AgentOut = ContractOutput<typeof agentGet>;
type AgentView = ReturnType<typeof toAgentDetail>;
type IncidentOut = ContractOutput<typeof tachoIncidentList>["items"][number];
type IncidentView = ReturnType<typeof toIncidentPage>["incidents"][number];
type ApiKeyOut = ContractOutput<typeof apiKeyList>["items"][number];
type ApiKeyView = ReturnType<typeof toApiKeys>[number];

type MandateOut = ContractOutput<typeof mandateList>["items"][number];
type MandateView = ReturnType<typeof toMandateList>["mandates"][number];
type RoleOut = ContractOutput<typeof iamRoleList>["roles"][number];
type RoleView = ReturnType<typeof toRoleCatalog>["roles"][number];
type WorkspaceOut = ContractOutput<typeof workspaceList>["workspaces"][number];
type WorkspaceView = ReturnType<typeof toWorkspaceList>["workspaces"][number];

declare const runOut: RunOut;
declare const runView: RunView;
declare const approvalView: ApprovalView;
declare const agentRowView: AgentRowView;
declare const identityView: AgentView["identity"];
declare const credentialView: AgentView["credentials"][number];
declare const hostView: AgentView["hosts"][number];
declare const incidentView: IncidentView;
declare const mandateView: MandateView;
declare const roleView: RoleView;
declare const workspaceView: WorkspaceView;
declare const apiKeyView: ApiKeyView;

type GateOut = ContractOutput<typeof onboardingStateGet>;
type GateView = ReturnType<typeof toOnboardingGate>;
type FrameOut = ContractOutput<typeof onboardingFirstFrameGet>;
type FrameView = ReturnType<typeof toFirstFrame>;

declare const gateView: GateView;
declare const frameView: FrameView;

// The positives: both mappers keep a field nullable only where the contract does.
const _runsHold: NullableOnlyWhenSourceIs<RunView, RunOut> = runView;
const _approvalsHold: NullableOnlyWhenSourceIs<ApprovalView, ApprovalOut> =
  approvalView;
const _agentRowsHold: NullableOnlyWhenSourceIs<AgentRowView, AgentRowOut> =
  agentRowView;
const _identityHolds: NullableOnlyWhenSourceIs<
  AgentView["identity"],
  AgentOut["identity"]
> = identityView;
const _credentialsHold: NullableOnlyWhenSourceIs<
  AgentView["credentials"][number],
  AgentOut["credentials"][number]
> = credentialView;
const _hostsHold: NullableOnlyWhenSourceIs<
  AgentView["hosts"][number],
  AgentOut["hosts"][number]
> = hostView;
const _incidentsHold: NullableOnlyWhenSourceIs<IncidentView, IncidentOut> =
  incidentView;
const _mandatesHold: NullableOnlyWhenSourceIs<MandateView, MandateOut> =
  mandateView;
// A role's description and author are nullable on both sides. So are a
// workspace's role, archival date, cost center, and avatar.
const _rolesHold: NullableOnlyWhenSourceIs<RoleView, RoleOut> = roleView;
const _workspacesHold: NullableOnlyWhenSourceIs<WorkspaceView, WorkspaceOut> =
  workspaceView;
const _gateHolds: NullableOnlyWhenSourceIs<GateView, GateOut> = gateView;
const _frameHolds: NullableOnlyWhenSourceIs<FrameView, FrameOut> = frameView;
const _apiKeysHold: NullableOnlyWhenSourceIs<ApiKeyView, ApiKeyOut> =
  apiKeyView;

// @ts-expect-error -- turns may be null on the contract, and frames is required on the view
const _nullableIntoRequired: Pick<RunView, "frames"> = { frames: runOut.turns };

type LoosenedRunView = Omit<RunView, "status"> & {
  status: RunView["status"] | null;
};
declare const loosened: LoosenedRunView;
// @ts-expect-error -- status is always recorded, so the view may not make it nullable
const _requiredIntoNullable: NullableOnlyWhenSourceIs<LoosenedRunView, RunOut> =
  loosened;

// The audit event (#3097). The renamed fields — actor, workspace and request —
// are not keys of the contract output, so the check reaches the six the view
// keeps by name, every one of them nullable on both sides or on neither.
type AuditOut = ContractOutput<typeof auditLogQuery>["events"][number];
type AuditEventView = ReturnType<typeof toAuditPage>["events"][number];
declare const auditOut: AuditOut;
declare const auditEventView: AuditEventView;

const _auditEventsHold: NullableOnlyWhenSourceIs<AuditEventView, AuditOut> =
  auditEventView;

const _auditNullableIntoRequired: Pick<AuditEventView, "eventType"> = {
  // @ts-expect-error -- capability may be null on the contract, and eventType is required on the view
  eventType: auditOut.capability,
};

type LoosenedAuditView = Omit<AuditEventView, "eventType"> & {
  eventType: string | null;
};
declare const loosenedAudit: LoosenedAuditView;
// @ts-expect-error -- every event records its type, so the view may not make it nullable
const _auditRequiredIntoNullable: NullableOnlyWhenSourceIs<
  LoosenedAuditView,
  AuditOut
> = loosenedAudit;
