// Plan §3 as data: for every read port method, the page that reads it, the
// store status today, the Batch 3 lane that wires its live adapter, and the
// milestone and backend gap (§3.4) it waits on.
//
//   backed  — the store exists today (§3 ✅); only the adapter is missing: M0, G0.
//   partial — some fields exist (§3 🟡); the gap names what is missing, or G0.
//   none    — no store today (§3 ❌); the milestone and gap that will back it.
//
// The live adapter returns `notBacked(milestone, gap)` from this table until
// its lane wires the method; the fixture adapter's `not_backed` state returns
// the same value, so e2e sees what production would show.
import {
  type GapId,
  type Milestone,
  NO_GAP,
  type NotBacked,
  notBacked,
} from "./not-backed";
import type { PageKey } from "./page-states";
import type { MethodName, PortName } from "./ports";

export type StoreStatus = "backed" | "partial" | "none";
export type LiveLane =
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "A6"
  | "A7"
  | "A8"
  | "A9"
  | "A10";

export type Backing = {
  page: PageKey;
  store: StoreStatus;
  lane: LiveLane;
  milestone: Milestone;
  gap: GapId;
};

type BackingTable = { [P in PortName]: { [M in MethodName<P>]: Backing } };

const wired = (
  page: PageKey,
  lane: LiveLane,
  store: "backed" | "partial" = "backed",
): Backing => ({
  page,
  store,
  lane,
  milestone: "M0",
  gap: NO_GAP,
});
const gap = (
  page: PageKey,
  lane: LiveLane,
  store: StoreStatus,
  milestone: Milestone,
  gapId: GapId,
): Backing => ({ page, store, lane, milestone, gap: gapId });

export const BACKING = {
  runs: {
    // §3.1 Fleet · runs list 🟡: tier, grade, verdict and proven spend need cost.run_totals.
    listRuns: gap("fleet", "A1", "partial", "M2", "G3"),
    // §3.1 Run · header 🟡: RunStore.getRunByPublicId.
    getRun: wired("run", "A1", "partial"),
    // §3.1 Run · frames 🟡: readAttemptEventsSince.
    framesSince: wired("run", "A1", "partial"),
    // §3.1 Run · frame bodies ❌ (G6: frame bodies in object store).
    transcript: gap("run", "A1", "none", "M1", "G6"),
    // §3.1 Run · linked work graph ❌: edges hang off the :Run node the recorder writes.
    runGraph: gap("run", "A1", "none", "M1", "G6"),
    // §3.1 Run · context window ❌ (G10, M3/M4).
    contextWindow: gap("run", "A1", "none", "M3", "G10"),
    // §3.1 Run · proof ❌ (G7, M6).
    proof: gap("run", "A1", "none", "M6", "G7"),
  },
  approvals: {
    // §3.1 Fleet · approvals ✅ request/decision; the mandate hop waits on G1.
    pending: wired("fleet", "A2", "partial"),
  },
  agents: {
    listAgents: wired("agents", "A3"),
    getAgent: wired("agent", "A3"),
    toolbelt: wired("agent", "A3"),
    // §3.1 Agents · definition in git 🟡: DB-backed agent.definition.*, not .oxagen/agents/*.toml.
    definition: wired("agent", "A3", "partial"),
    // §3.1 Agents · trust/spend scores ❌ (G11, spec decision first).
    scores: gap("agent", "A3", "none", "spec-decision", "G11"),
    incidents: wired("agent", "A3"),
    mandates: gap("agent", "A3", "none", "M2", "G1"),
    getMandate: gap("mandate", "A3", "none", "M2", "G1"),
  },
  iam: {
    roles: wired("organization", "A8"),
    // W7: the role editor's permission catalogue is mockup-only (§3.3).
    permissionCatalog: gap(
      "organization",
      "A8",
      "none",
      "spec-decision",
      NO_GAP,
    ),
  },
  tools: {
    servers: wired("tools", "A4"),
    toolVersions: wired("tools", "A4", "partial"),
    connections: wired("tools", "A4", "partial"),
    // §3.1 Tools · observed schemas ❌ (M2, no gap id).
    observedSchemas: gap("tools", "A4", "none", "M2", NO_GAP),
    mandateLedger: gap("tools", "A4", "none", "M2", "G1"),
    policyVersions: gap("tools", "A4", "none", "M2", "G2"),
    policySimulation: gap("tools", "A4", "none", "M2", "G2"),
    // §3.1 Tools · kill switches 🟡: iam.emergency_denies.
    killSwitches: wired("tools", "A4", "partial"),
    autoApprovalRules: gap("tools", "A4", "none", "M2", "G12"),
    // §3.1 Tools · assurance ❌ (M2 suite, no gap id).
    assurance: gap("tools", "A4", "none", "M2", NO_GAP),
  },
  ontology: {
    // §3.1 Ontology · model map 🟡: schema_registry + graph stats carry the rest;
    // rulesReferencing and per-class freshAt are unrecorded, so the live read
    // waits on those fields becoming nullable in the view model (A5 promote).
    classes: wired("ontology", "A5", "partial"),
    // §3.1 Ontology · sources 🟡 (A5 column check): list_connections + mappings.
    sources: wired("ontology", "A5", "partial"),
    // §3.1 Ontology · repositories: §3 said ✅; at column level repository_bindings
    // has name and branch only. Role, indexed commit, issues, events, symbols and
    // drift are the M4 GitHub link (spec §11.4), no gap id.
    repositories: gap("ontology", "A5", "partial", "M4", NO_GAP),
    // §3.1 Ontology · versions 🟡: commit, pull request and author need the
    // ontology in git (spec §11.8, M4); schema_versions carries none of them.
    versions: gap("ontology", "A5", "partial", "M4", NO_GAP),
    // §3.1 Ontology · embedding indexes ❌ (Voyage indexes, M4).
    embeddingIndexes: gap("ontology", "A5", "none", "M4", NO_GAP),
  },
  steering: {
    records: wired("steering", "A6"),
    proposals: wired("steering", "A6", "partial"),
    // §3.1 Steering · effect, retirement ❌ (effect metrics, M3).
    effect: gap("steering", "A6", "none", "M3", NO_GAP),
    retirementCandidates: gap("steering", "A6", "none", "M3", NO_GAP),
  },
  spend: {
    // §3.1 Spend · totals 🟡: proven vs unproven needs G7; rollups need G3.
    summary: gap("spend", "A7", "partial", "M2", "G3"),
    byOperator: wired("spend", "A7", "partial"),
    byAgent: wired("spend", "A7", "partial"),
    byModel: wired("spend", "A7", "partial"),
    byTool: wired("spend", "A7", "partial"),
    // Waste is spend whose frames show it bought nothing: it needs verdicts (G7).
    waste: gap("spend", "A7", "none", "M6", "G7"),
    drill: wired("spend", "A7", "partial"),
    findings: gap("spend", "A7", "none", "M2", "G4"),
    findingEvidence: gap("spend", "A7", "none", "M2", "G4"),
    findingFix: gap("spend", "A7", "none", "M2", "G4"),
    reconciliation: gap("spend", "A7", "none", "M5", "G5"),
    budgets: wired("spend", "A7"),
  },
  org: {
    organization: wired("organization", "A8"),
    members: wired("organization", "A8"),
    invitations: wired("organization", "A8"),
    workspaces: wired("organization", "A8"),
    apiKeys: wired("organization", "A8"),
    dataPlanes: wired("organization", "A8"),
    // §3.2 Organization · model funding + routes 🟡.
    modelFunding: wired("organization", "A8", "partial"),
  },
  billing: {
    plan: wired("billing", "A9"),
    // §3.2 Billing · run allowance, meters ❌ (G13, the billing rebuild).
    allowance: gap("billing", "A9", "none", "M2", "G13"),
    meters: gap("billing", "A9", "none", "M2", "G13"),
    invoices: wired("billing", "A9"),
  },
  audit: {
    events: wired("audit", "A10", "partial"),
    incidents: wired("audit", "A10"),
    receipts: gap("audit", "A10", "none", "M5", "G8"),
    getReceipt: gap("audit", "A10", "none", "M5", "G8"),
    holds: gap("audit", "A10", "none", "M5", "G8"),
    exports: wired("audit", "A10", "partial"),
    // §3.2 Audit · keys, KEK rotation ❌ (KMS per org; A10 lists it under G8).
    keys: gap("audit", "A10", "none", "M5", "G8"),
    erasure: wired("audit", "A10", "partial"),
    retention: wired("audit", "A10", "partial"),
    // §3.2 Audit · assurance history ❌ (M2 suite, no gap id).
    assuranceHistory: gap("audit", "A10", "none", "M2", NO_GAP),
  },
  shell: {
    notifications: wired("shell", "A10"),
    people: wired("shell", "A10"),
    // §3.2 Shell · assistant flyout 🟡: stella-serve health.
    assistantEngine: wired("shell", "A10", "partial"),
  },
} as const satisfies BackingTable;

export function backingOf<P extends PortName>(
  port: P,
  method: MethodName<P>,
): Backing {
  const table: BackingTable[P] = BACKING[port];
  return table[method];
}

/** What a read with no adapter yet returns: its milestone and gap, never a zero. */
export function notBackedFor<P extends PortName>(
  port: P,
  method: MethodName<P>,
): NotBacked {
  const { milestone, gap: gapId } = backingOf(port, method);
  return notBacked(milestone, gapId);
}

/** Every (port, method) pair, for tests that walk the whole surface. */
export function allMethods(): Array<{
  port: PortName;
  method: string;
  backing: Backing;
}> {
  return Object.entries(BACKING).flatMap(([port, methods]) =>
    Object.entries(methods).map(([method, backing]) => ({
      port: port as PortName,
      method,
      backing,
    })),
  );
}
