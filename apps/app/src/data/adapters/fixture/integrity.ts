// Referential integrity of the fixture seed (plan W4). Every id one collection
// cites must name a row another collection has, or a link in the app 404s. The
// integrity test fails on any dangling reference this returns.
import type { Seed } from "./seed-schema";

export type DanglingReference = {
  /** Where the reference sits, e.g. `runs[run_01K5…].agentKey`. */
  at: string;
  /** The collection the id should name a row of. */
  expected: string;
  ref: string;
};

/** The in-app agent acts under its own service key, not an enrolled agent's. */
const SYSTEM_AGENTS = new Set(["oxagen.assistant"]);

export function findDanglingReferences(seed: Seed): DanglingReference[] {
  const dangling: DanglingReference[] = [];
  const ids = {
    agents: new Set(seed.agents.map((a) => a.key)),
    people: new Set(seed.people.map((p) => p.id)),
    workspaces: new Set(seed.workspaces.map((w) => w.slug)),
    runs: new Set(seed.runs.map((r) => r.id)),
    approvals: new Set(seed.approvals.map((a) => a.id)),
    mandates: new Set(seed.mandates.map((m) => m.id)),
    policies: new Set(seed.policyVersions.map((p) => p.id)),
    roles: new Set(seed.roles.map((r) => r.name)),
    servers: new Set(seed.servers.map((s) => s.id)),
    connections: new Set(seed.connections.map((c) => c.id)),
    toolVersions: new Set(
      seed.toolVersions.map((t) => `${t.name}@${t.version}`),
    ),
    tools: new Set(seed.toolVersions.map((t) => t.name)),
    records: new Set(seed.records.map((r) => r.lineage)),
    findings: new Set(seed.spend.findings.map((f) => f.id)),
    receipts: new Set(seed.audit.receipts.map((r) => r.id)),
    holds: new Set(seed.audit.holds.map((h) => h.id)),
    witnesses: new Set(Object.values(seed.proofs).map((p) => p.witnessId)),
    switches: new Set(seed.killSwitches.map((s) => s.id)),
  };
  type IdSet = keyof typeof ids;

  const expect = (
    at: string,
    expected: IdSet,
    ref: string | null | undefined,
  ) => {
    if (ref === null || ref === undefined) return;
    if (!ids[expected].has(ref)) dangling.push({ at, expected, ref });
  };

  // ---- runs and what hangs off them ----
  for (const r of seed.runs) {
    expect(`runs[${r.id}].agentKey`, "agents", r.agentKey);
    expect(`runs[${r.id}].operatorId`, "people", r.operatorId);
    expect(`runs[${r.id}].workspaceSlug`, "workspaces", r.workspaceSlug);
  }
  for (const [name, keyed] of [
    ["frames", seed.frames],
    ["transcripts", seed.transcripts],
    ["runGraphs", seed.runGraphs],
    ["contextWindows", seed.contextWindows],
    ["proofs", seed.proofs],
  ] as const) {
    for (const runId of Object.keys(keyed))
      expect(`${name}[${runId}]`, "runs", runId);
  }
  for (const [runId, entries] of Object.entries(seed.transcripts)) {
    entries.forEach((e, i) => {
      if (e.kind === "prompt" || e.kind === "steer")
        expect(
          `transcripts[${runId}][${String(i)}].byPersonId`,
          "people",
          e.byPersonId,
        );
      if (e.kind === "tool")
        expect(
          `transcripts[${runId}][${String(i)}].parked.approvalId`,
          "approvals",
          e.parked?.approvalId,
        );
    });
  }

  // ---- approvals and mandates ----
  for (const a of seed.approvals) {
    const at = `approvals[${a.id}]`;
    expect(`${at}.runId`, "runs", a.runId);
    expect(`${at}.chain.agentKey`, "agents", a.chain.agentKey);
    expect(`${at}.chain.operatorId`, "people", a.chain.operatorId);
    expect(`${at}.mandateId`, "mandates", a.mandateId);
    expect(`${at}.policyVersionId`, "policies", a.policyVersionId);
    expect(`${at}.workspaceSlug`, "workspaces", a.workspaceSlug);
    for (const id of a.approvers.eligiblePersonIds)
      expect(`${at}.approvers.eligible`, "people", id);
    for (const x of a.approvers.excluded)
      expect(`${at}.approvers.excluded`, "people", x.personId);
    const run = seed.runs.find((r) => r.id === a.runId);
    if (run && run.agentKey !== a.chain.agentKey) {
      dangling.push({
        at: `${at}.chain.agentKey`,
        expected: `the agent of ${run.id}`,
        ref: a.chain.agentKey,
      });
    }
  }
  for (const m of seed.mandates) {
    const at = `mandates[${m.id}]`;
    expect(`${at}.agentKey`, "agents", m.agentKey);
    expect(`${at}.grantedById`, "people", m.grantedById);
    expect(`${at}.secondApproverId`, "people", m.secondApproverId);
  }
  seed.mandateLedger.forEach((entry, i) => {
    expect(
      `mandateLedger[${String(i)}].mandateId`,
      "mandates",
      entry.mandateId,
    );
    expect(
      `mandateLedger[${String(i)}].receiptId`,
      "receipts",
      entry.receiptId,
    );
  });

  // ---- agents ----
  for (const a of seed.agents) {
    const at = `agents[${a.key}]`;
    expect(`${at}.operatorId`, "people", a.operatorId);
    expect(`${at}.workspaceSlug`, "workspaces", a.workspaceSlug);
    for (const id of a.mandateIds ?? [])
      expect(`${at}.mandateIds`, "mandates", id);
    for (const r of a.roles) expect(`${at}.roles`, "roles", r.role);
  }
  for (const belt of seed.toolbelts) {
    expect(`toolbelts[${belt.agentKey}]`, "agents", belt.agentKey);
    for (const entry of belt.entries)
      expect(`toolbelts[${belt.agentKey}].entries`, "toolVersions", entry.tool);
  }
  for (const d of seed.definitions) {
    expect(`definitions[${d.agentKey}]`, "agents", d.agentKey);
    for (const b of d.branches ?? [])
      expect(
        `definitions[${d.agentKey}].branches[${b.name}].authorId`,
        "people",
        b.authorId,
      );
  }
  for (const s of seed.scores)
    expect(`scores[${s.agentKey}]`, "agents", s.agentKey);

  // ---- tools ----
  for (const s of seed.servers)
    expect(`servers[${s.id}].connectionId`, "connections", s.connectionId);
  for (const t of seed.toolVersions)
    expect(
      `toolVersions[${t.name}@${t.version}].serverId`,
      "servers",
      t.serverId,
    );
  for (const c of seed.connections) {
    expect(`connections[${c.id}].ownerId`, "people", c.ownerId);
    for (const s of c.serverIds)
      expect(`connections[${c.id}].serverIds`, "servers", s);
  }
  for (const o of seed.observedSchemas)
    expect(
      `observedSchemas[${o.tool}]`,
      "toolVersions",
      `${o.tool}@${o.version}`,
    );
  for (const s of seed.killSwitches) {
    const at = `killSwitches[${s.id}]`;
    expect(`${at}.flippedById`, "people", s.flippedById);
    if (s.level === "agent") expect(`${at}.target`, "agents", s.target);
    if (s.level === "tool_server") expect(`${at}.target`, "servers", s.target);
    if (s.level === "tool_version")
      expect(`${at}.target`, "toolVersions", s.target);
    if (s.level === "operator") expect(`${at}.target`, "people", s.target);
    if (s.level === "workspace") expect(`${at}.target`, "workspaces", s.target);
    if (s.level === "org" && s.target !== seed.organization.slug) {
      dangling.push({
        at: `${at}.target`,
        expected: "organization",
        ref: s.target,
      });
    }
    // Connection switches may name a connection the page lists without a
    // CONNECTIONS row (the mockup's Snowflake key); the page does not link them.
  }
  for (const r of seed.autoApprovalRules) {
    expect(
      `autoApprovalRules[${r.id}].workspaceSlug`,
      "workspaces",
      r.workspaceSlug,
    );
    expect(`autoApprovalRules[${r.id}].createdById`, "people", r.createdById);
  }
  for (const p of seed.policyVersions)
    expect(`policyVersions[${p.id}].authoredById`, "people", p.authoredById);
  for (const s of seed.policySimulations) {
    expect(
      `policySimulations[${s.policyVersionId}]`,
      "policies",
      s.policyVersionId,
    );
    for (const key of s.agentsAffected)
      expect(
        `policySimulations[${s.policyVersionId}].agentsAffected`,
        "agents",
        key,
      );
  }

  // ---- ontology and steering ----
  for (const v of seed.ontologyVersions)
    expect(
      `ontologyVersions[${v.version}].authoredById`,
      "people",
      v.authoredById,
    );
  for (const p of seed.proposals) {
    const at = `proposals[${p.id}].source.ref`;
    if (p.source.kind === "findings_job") expect(at, "findings", p.source.ref);
    if (p.source.kind === "reflector") expect(at, "runs", p.source.ref);
    if (p.source.kind === "person") expect(at, "people", p.source.ref);
  }
  for (const e of seed.recordEffects)
    expect(`recordEffects[${e.lineage}]`, "records", e.lineage);
  for (const c of seed.retirementCandidates)
    expect(`retirementCandidates[${c.lineage}]`, "records", c.lineage);

  // ---- spend ----
  const sp = seed.spend;
  for (const o of sp.byOperator)
    expect(`spend.byOperator[${o.operatorId}]`, "people", o.operatorId);
  for (const a of sp.byAgent)
    expect(`spend.byAgent[${a.agentKey}]`, "agents", a.agentKey);
  for (const w of sp.waste.worstRuns)
    expect(`spend.waste.worstRuns[${w.runId}]`, "runs", w.runId);
  for (const d of sp.drills) {
    const at = `spend.drills[${d.kind}:${d.id}]`;
    if (d.kind === "operator") expect(at, "people", d.id);
    if (d.kind === "agent") expect(at, "agents", d.id);
    if (d.kind === "tool") expect(at, "tools", d.id);
    for (const s of d.agents) expect(`${at}.agents`, "agents", s.key);
    for (const s of d.operators) expect(`${at}.operators`, "people", s.key);
    for (const s of d.tools) expect(`${at}.tools`, "tools", s.key);
  }
  for (const f of sp.findings) {
    const at = `spend.findings[${f.id}].subject`;
    if (f.level === "agent") expect(at, "agents", f.subject);
    if (f.level === "operator") expect(at, "people", f.subject);
    if (f.level === "workspace") expect(at, "workspaces", f.subject);
    if (f.level === "tool") expect(at, "tools", f.subject);
  }
  for (const e of sp.evidence) {
    const at = `spend.evidence[${e.findingId}]`;
    expect(at, "findings", e.findingId);
    expect(`${at}.who.agentKey`, "agents", e.who.agentKey);
    expect(`${at}.who.operatorId`, "people", e.who.operatorId);
    for (const r of e.runs) expect(`${at}.runs`, "runs", r.runId);
  }
  for (const f of sp.fixes)
    expect(`spend.fixes[${f.findingId}]`, "findings", f.findingId);
  for (const b of sp.budgets) {
    const at = `spend.budgets[${b.scopeKind}:${b.scopeId}]`;
    if (b.scopeKind === "agent") expect(at, "agents", b.scopeId);
    if (b.scopeKind === "workspace") expect(at, "workspaces", b.scopeId);
    if (b.scopeKind === "operator") expect(at, "people", b.scopeId);
    if (b.scopeKind === "org" && b.scopeId !== seed.organization.slug) {
      dangling.push({ at, expected: "organization", ref: b.scopeId });
    }
  }

  // ---- organization ----
  for (const w of seed.workspaces)
    expect(`workspaces[${w.slug}].ownerId`, "people", w.ownerId);
  for (const m of seed.members) {
    expect(`members[${m.personId}]`, "people", m.personId);
    for (const w of m.workspaces)
      expect(`members[${m.personId}].workspaces`, "workspaces", w.slug);
  }
  for (const i of seed.invitations) {
    expect(`invitations[${i.email}].invitedById`, "people", i.invitedById);
    if (i.role.scope === "workspace")
      expect(
        `invitations[${i.email}].role`,
        "workspaces",
        i.role.workspaceSlug,
      );
  }
  for (const k of seed.apiKeys)
    expect(`apiKeys[${k.name}].createdById`, "people", k.createdById);
  for (const p of seed.people) {
    for (const w of p.workspaceRoles)
      expect(`people[${p.id}].workspaceRoles`, "workspaces", w.slug);
  }

  // ---- audit and shell ----
  seed.audit.events.forEach((e, i) => {
    if (e.actor.kind === "agent")
      expect(`audit.events[${String(i)}].actor`, "agents", e.actor.agentKey);
    if (e.actor.kind === "person")
      expect(`audit.events[${String(i)}].actor`, "people", e.actor.personId);
  });
  for (const inc of seed.audit.incidents) {
    const at = `audit.incidents[${inc.id}]`;
    expect(`${at}.agentKey`, "agents", inc.agentKey);
    expect(`${at}.ownerId`, "people", inc.ownerId);
    for (const id of inc.runIds) expect(`${at}.runIds`, "runs", id);
  }
  for (const r of seed.audit.receipts) {
    const at = `audit.receipts[${r.id}]`;
    if (!SYSTEM_AGENTS.has(r.agent)) expect(`${at}.agent`, "agents", r.agent);
    expect(`${at}.operatorId`, "people", r.operatorId);
    expect(`${at}.runId`, "runs", r.runId);
    expect(`${at}.workspaceSlug`, "workspaces", r.workspaceSlug);
  }
  for (const h of seed.audit.holds)
    expect(`audit.holds[${h.id}].placedById`, "people", h.placedById);
  for (const x of seed.audit.exports)
    expect(`audit.exports[${x.id}].createdById`, "people", x.createdById);
  for (const e of seed.audit.erasure) {
    expect(`audit.erasure[${e.id}].requestedById`, "people", e.requestedById);
    expect(`audit.erasure[${e.id}].holdId`, "holds", e.holdId);
  }
  for (const n of seed.notifications) {
    expect(`notifications[${n.id}].runId`, "runs", n.runId);
    const ref = n.ref ?? "";
    if (ref.startsWith("apr_"))
      expect(`notifications[${n.id}].ref`, "approvals", ref);
    if (ref.startsWith("run_"))
      expect(`notifications[${n.id}].ref`, "runs", ref);
    if (ref.startsWith("wit_"))
      expect(`notifications[${n.id}].ref`, "witnesses", ref);
    if (ref.startsWith("ksw_"))
      expect(`notifications[${n.id}].ref`, "switches", ref);
  }

  // ---- onboarding ----
  const { onboarding } = seed;
  const { namespaces } = onboarding;
  for (const slug of Object.keys(namespaces.workspaces))
    expect(`onboarding.namespaces.workspaces[${slug}]`, "workspaces", slug);
  for (const a of seed.agents) {
    const ws = namespaces.workspaces[a.workspaceSlug];
    const prefix = `${namespaces.org}.${ws ?? "?"}.`;
    if (ws === undefined || !a.key.startsWith(prefix))
      dangling.push({
        at: `agents[${a.key}].key`,
        expected: `a key minted in ${prefix}`,
        ref: a.key,
      });
  }
  const personNames = new Set(seed.people.map((p) => p.name));
  for (const inv of onboarding.invitations) {
    const at = `onboarding.invitations[${inv.token}]`;
    if (
      inv.orgSlug !== seed.organization.slug ||
      inv.orgName !== seed.organization.name
    )
      dangling.push({
        at: `${at}.orgSlug`,
        expected: "organization",
        ref: inv.orgSlug,
      });
    if (inv.inviterName !== null && !personNames.has(inv.inviterName))
      dangling.push({
        at: `${at}.inviterName`,
        expected: "people",
        ref: inv.inviterName,
      });
  }
  if (onboarding.firstFrame.host !== onboarding.installer.host)
    dangling.push({
      at: "onboarding.firstFrame.host",
      expected: "the installer's host",
      ref: onboarding.firstFrame.host,
    });

  return dangling;
}
