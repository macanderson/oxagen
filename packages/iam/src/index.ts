// packages/iam/src/index.ts — @oxagen/iam public surface.
//
// The impure IAM enforcement runtime: DB reads, ClickHouse writes, and
// access-request creation. Depends on @oxagen/database and @oxagen/telemetry.
// The pure IAM resolver lives in @oxagen/oxagen/iam (dep-light).

export { denial, isDenial } from "./denial";
export type { DenialResponse } from "./denial";

export { fetchAuthz } from "./fetch-authz";
export type { AuthzData, FetchAuthzArgs } from "./fetch-authz";

export {
  fetchAgentRunAuthz,
  fetchAgentRunLiveAuthority,
} from "./fetch-agent-authz";
export type { FetchAgentRunAuthzArgs } from "./fetch-agent-authz";

// Governed-run authorization foundation (docs/specs/run-evidence-ingress).
// The PINNED grant ceiling …
export {
  createAgentRunAuthorizationSnapshot,
  createChildRunAuthorizationSnapshot,
  loadAuthorizationSnapshot,
  parseStoredCeiling,
  readDenyGenerationVector,
  readLiveAuthority,
  AuthorizationSnapshotError,
} from "./authorization-snapshot";
export type {
  CreateAgentRunAuthorizationSnapshotArgs,
  CreateChildRunAuthorizationSnapshotArgs,
  LiveAuthorityState,
  LivePrincipalStatus,
  LiveRoleAssignment,
  LiveRoleGrant,
} from "./authorization-snapshot";

// … and the LIVE deny check that can only narrow it.
export {
  evaluateAgentRunAuthorization,
  liveResolverInputs,
  matchEmergencyDeny,
  persistAuthorizationDecision,
  persistedOutcomeOf,
  readActiveEmergencyDenies,
  readLiveAgentRunAuthority,
} from "./live-agent-run-authorization";
export type {
  ActiveEmergencyDeny,
  AgentRunAuthorizationResult,
  EvaluateAgentRunAuthorizationArgs,
  LiveAgentRunAuthority,
  LiveDenyReason,
  PersistAuthorizationDecisionArgs,
  PersistedDecisionOutcome,
} from "./live-agent-run-authorization";

export { resourceScopeDigestOf } from "./resource-scope";

export { assertNoActiveKillSwitch } from "./kill-switch-guard";

export {
  flipKillSwitchOff,
  flipKillSwitchOn,
  matchKillSwitch,
  readActiveKillSwitches,
  readActiveKillSwitchesForTargets,
  readKillSwitches,
} from "./kill-switch";
export type {
  KillSwitchDeny,
  KillSwitchRow,
  KillSwitchTargetKind,
} from "./kill-switch";

export { emitAudit } from "./emit-audit";
export type { EmitAuditArgs } from "./emit-audit";

export { checkIAM } from "./check-iam";
export type { CheckIAMArgs, CheckIAMResult } from "./check-iam";

export { createAccessRequest } from "./access-request";
export type { CreateAccessRequestArgs } from "./access-request";

export { bootstrapIAMRuntime } from "./bootstrap";

export { resolveAgentRunAuthzContext } from "./agent-run-context";
export type {
  AgentRunAuthzContext,
  ResolveAgentRunAuthzContextArgs,
} from "./agent-run-context";

// The delegation ceiling: a granter cannot hand out more than they hold. One
// implementation for assign_agent_role and the role editor (ADR-063).
export {
  findDelegationCeilingViolations,
  postgresDelegationCeilingReads,
} from "./delegation-ceiling";
export type {
  ConferredGrant,
  DelegationCeilingReads,
} from "./delegation-ceiling";
