export const meta = {
  name: 'pkg-review-p0p1',
  description: 'Line-by-line review of packages/ via 7 named reviewer agents; adversarially verify P0/P1 findings',
  phases: [
    { title: 'Review', detail: '7 named reviewers per unit across 35 review units' },
    { title: 'Verify', detail: 'independently confirm each P0/P1 candidate against source' },
  ],
}

const WT = '/home/macanderson/Workspaces/oxagen-pkg-review'
const MANIFEST = `${WT}/.pkg-review-units.json`

const AGENT_OF = {
  db: 'eval-database',
  perf: 'eval-performance',
  ts: 'eval-typescript',
  types: 'eval-types',
  comments: 'eval-comments',
  arch: 'eval-architecture',
  sec: 'eval-security',
}

const LENS_FOCUS = {
  db: 'SQL correctness, injection, missing tenant scoping/RLS, N+1 queries, missing indexes, wrong store (Postgres/Neo4j/ClickHouse) per the four-store model, unsafe migrations, transaction/locking bugs.',
  perf: 'hot-path inefficiency, N+1, unbounded queries/loops, missing pagination, blocking sync work, redundant fetches, large allocations, missing caching where it matters.',
  ts: 'type-safety holes (any/unsafe casts), async correctness (missing await, unhandled rejection, race conditions), incorrect error handling/swallowed errors, off-by-one/logic bugs, null/undefined hazards.',
  types: 'unsound types that permit invalid states, missing invariants, encapsulation leaks that cause real runtime bugs.',
  comments: 'comments that are actively wrong/misleading in a way that causes incorrect usage. Only escalate to P0/P1 if a wrong comment drives a real defect.',
  arch: 'storage-boundary violations, dead/duplicated logic causing divergence, vendor lock, append-only hygiene, layering violations that cause real bugs.',
  sec: 'secrets in code, SSRF, injection (SQL/command/template), unsafe crypto, authz/authn gaps, tenant isolation breaches, unsafe deserialization, path traversal, missing input validation on trust boundaries.',
}

const SEVERITY_RUBRIC = `Severity:
- P0 = critical: exploitable security vuln, data loss/corruption, cross-tenant data leak, money/billing miscalculation, crash on a core path, broken auth.
- P1 = high: a real bug with clear user/system impact — missing await, race, unscoped query, incorrect business logic, type unsoundness that throws at runtime, N+1 on a hot path.
- P2 = medium, P3 = low/nit.
Only report something as P0/P1 if you can point to the exact line(s) and explain the concrete failure. Do NOT inflate severity. Style/preference issues are never P0/P1.`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'startLine', 'endLine', 'severity', 'title', 'problem', 'fix', 'confidence'],
        properties: {
          file: { type: 'string', description: 'repo-relative path, e.g. packages/billing/src/x.ts' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          problem: { type: 'string', description: 'concrete description of the defect and its impact' },
          fix: { type: 'string', description: 'specific code change that resolves it' },
          confidence: { type: 'number' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'severity', 'reason', 'preciseFix', 'confidence'],
  properties: {
    isReal: { type: 'boolean', description: 'true only if you confirmed the defect by reading the actual code' },
    severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    reason: { type: 'string' },
    preciseFix: { type: 'string', description: 'exact, minimal change to apply (file + what to change)' },
    confidence: { type: 'number' },
  },
}

function reviewPrompt(unit, lens) {
  return `You are the ${AGENT_OF[lens]} performing a LINE-BY-LINE review of one slice of the Oxagen monorepo's packages/ directory.

Working tree root: ${WT}
1. Read the manifest file ${MANIFEST} (JSON array). Find the object whose "id" === "${unit.id}". Its "files" array lists the EXACT repo-relative files you must review — review ALL of them, reading each file fully. Resolve each path against the working tree root above.
2. Review focus for your lens: ${LENS_FOCUS[lens]}
3. ${SEVERITY_RUBRIC}

Project rules that matter for severity (from CLAUDE.md / engineering policy):
- Four-store model: Postgres=transactional, Neo4j=graph, ClickHouse=append-only events, blob=binary. Storing data in the wrong store is an architecture defect.
- Raw db() is banned; tenant-scoped access must go through withTenantDb/withSystemDb/scopedSession. Missing tenant scoping is a P0/P1 isolation risk.
- All LLM calls must go through @oxagen/ai re-exports (metering). Direct imports from 'ai' in handlers are a defect.
- invoke() requires handler registration; forgetting silently no-ops metering/IAM.

Report every genuine defect you find with exact line numbers. Prioritize P0/P1 but include notable P2/P3 too. If the slice is clean, return an empty findings array. Be precise and conservative on severity — false P0/P1 alarms waste downstream fix effort.`
}

function verifyPrompt(f) {
  return `You are an independent, skeptical verifier. A reviewer (${f.lens} lens) flagged a potential ${f.severity} defect. Confirm or refute it by reading the ACTUAL source — do not trust the claim.

Working tree root: ${WT}
File: ${f.file}  (lines ${f.startLine}-${f.endLine})
Claimed title: ${f.title}
Claimed problem: ${f.problem}
Proposed fix: ${f.fix}

Read the cited file (and any related files needed to judge context) under the working tree root. Then decide:
- isReal: true ONLY if the defect genuinely exists and would cause the stated impact. Default to false if you cannot concretely confirm it.
- severity: your independent re-rating (P0/P1/P2/P3). Downgrade if the impact is overstated.
- preciseFix: the exact minimal change to fix it (only if isReal).
${SEVERITY_RUBRIC}
Be rigorous: plausible-sounding but unconfirmed claims must be marked isReal=false.`
}

phase('Review')
const ALL = ['db', 'perf', 'ts', 'types', 'comments', 'arch', 'sec']
const DECL = ['ts', 'types', 'arch', 'comments', 'sec']
const UI = ['perf', 'ts', 'types', 'comments', 'arch', 'sec']
const units = [
  { id: 'oxagen-contracts-1', lenses: DECL },
  { id: 'oxagen-contracts-2', lenses: DECL },
  { id: 'oxagen-contracts-3', lenses: DECL },
  { id: 'oxagen-contracts-4', lenses: DECL },
  { id: 'oxagen-contracts-5', lenses: DECL },
  { id: 'oxagen-contracts-6', lenses: DECL },
  { id: 'oxagen-core', lenses: ALL },
  { id: 'handlers-1', lenses: ALL },
  { id: 'handlers-2', lenses: ALL },
  { id: 'handlers-3', lenses: ALL },
  { id: 'handlers-4', lenses: ALL },
  { id: 'handlers-5', lenses: ALL },
  { id: 'agent-handlers', lenses: ALL },
  { id: 'agent-core', lenses: ALL },
  { id: 'database', lenses: ALL },
  { id: 'inngest-functions', lenses: ALL },
  { id: 'billing', lenses: ALL },
  { id: 'ingestion', lenses: ALL },
  { id: 'notifications', lenses: ALL },
  { id: 'plugins', lenses: ALL },
  { id: 'ai', lenses: ALL },
  { id: 'telemetry', lenses: ALL },
  { id: 'auth', lenses: ALL },
  { id: 'iam', lenses: ALL },
  { id: 'crypto', lenses: ALL },
  { id: 'storage', lenses: ALL },
  { id: 'sandbox', lenses: ALL },
  { id: 'ontology', lenses: ALL },
  { id: 'skills', lenses: ALL },
  { id: 'config', lenses: ALL },
  { id: 'tenancy', lenses: ALL },
  { id: 'compliance', lenses: ALL },
  { id: 'functions', lenses: ALL },
  { id: 'ui', lenses: UI },
  { id: 'web', lenses: UI },
]

const confirmedByUnit = await pipeline(
  units,
  // Stage 1: run every assigned lens reviewer on this unit, flatten findings.
  async (unit) => {
    const results = await parallel(
      unit.lenses.map((lens) => () =>
        agent(reviewPrompt(unit, lens), {
          label: `${unit.id}:${lens}`,
          phase: 'Review',
          schema: FINDINGS_SCHEMA,
          agentType: AGENT_OF[lens],
        }).then((r) => ({ lens, findings: (r && r.findings) || [] }))
      )
    )
    return results
      .filter(Boolean)
      .flatMap((r) => r.findings.map((f) => ({ ...f, lens: r.lens, unit: unit.id })))
  },
  // Stage 2: verify only the P0/P1 candidates from this unit.
  async (findings, unit) => {
    const p01 = (findings || []).filter((f) => f.severity === 'P0' || f.severity === 'P1')
    if (!p01.length) return []
    const verified = await parallel(
      p01.map((f) => () =>
        agent(verifyPrompt(f), {
          label: `verify:${unit.id}:${f.file.split('/').pop()}`,
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
        }).then((v) => ({ ...f, verdict: v }))
      )
    )
    return verified
      .filter(Boolean)
      .filter((x) => x.verdict && x.verdict.isReal && (x.verdict.severity === 'P0' || x.verdict.severity === 'P1'))
      .map((x) => ({
        file: x.file,
        startLine: x.startLine,
        endLine: x.endLine,
        lens: x.lens,
        unit: x.unit,
        severity: x.verdict.severity,
        title: x.title,
        problem: x.problem,
        fix: x.verdict.preciseFix || x.fix,
        confidence: x.verdict.confidence,
      }))
  }
)

const confirmed = confirmedByUnit.filter(Boolean).flat()
log(`Confirmed P0/P1 findings: ${confirmed.length}`)
const byPkg = {}
for (const f of confirmed) {
  const pkg = f.file.split('/').slice(0, 2).join('/')
  ;(byPkg[pkg] = byPkg[pkg] || []).push(f)
}
return { confirmed, byPkg, counts: { total: confirmed.length, p0: confirmed.filter((f) => f.severity === 'P0').length, p1: confirmed.filter((f) => f.severity === 'P1').length } }
