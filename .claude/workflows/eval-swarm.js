export const meta = {
  name: 'eval-swarm',
  description: 'Fan every eval-* evaluator agent across slices of the monorepo, adversarially verify P0/P1 findings, then route confirmed code defects to break-fix for grouped remediation.',
  phases: [
    { title: 'Review', detail: 'each eval-* lens reviews each assigned slice' },
    { title: 'Verify', detail: 'independently confirm every P0/P1 candidate against source' },
    { title: 'Remediate', detail: 'break-fix fixes confirmed P0/P1, grouped by package, in isolated worktrees' },
  ],
}

// ---------------------------------------------------------------------------
// Slices come from `args` (the /eval-swarm command scouts the tree first and
// passes them in — the workflow sandbox has no filesystem access of its own).
//   args = {
//     slices:    [{ id, path, kind: 'code' | 'ui' }, ...],
//     repoLevel: boolean,   // also run the repo-wide auditors once (default true)
//     fix:       boolean,   // run the Remediate phase (default true)
//   }
// Falls back to two coarse slices if nothing was passed.
// ---------------------------------------------------------------------------
const slices =
  (args && Array.isArray(args.slices) && args.slices.length && args.slices) || [
    { id: 'packages', path: 'packages', kind: 'code' },
    { id: 'apps', path: 'apps', kind: 'ui' },
  ]
const runRepoLevel = !args || args.repoLevel !== false
const runFix = !args || args.fix !== false

// Per-slice lenses → the eval-* agent that owns each lens.
const CODE_LENSES = [
  'eval-database',
  'eval-typescript',
  'eval-types',
  'eval-comments',
  'eval-architecture',
  'eval-security',
  'eval-performance',
  'eval-silent-failure',
]
// Pure-UI slices skip the SQL/DB lens.
const UI_LENSES = CODE_LENSES.filter((l) => l !== 'eval-database')

// Repo-wide auditors that are not slice-scoped — run once over the whole tree.
const REPO_LENSES = ['eval-compliance', 'eval-parity', 'eval-pr-hygiene', 'eval-test-build', 'eval-grep']

const LENS_FOCUS = {
  'eval-database':
    'SQL correctness, injection, missing tenant scoping/RLS, N+1 queries, missing indexes, wrong store per the four-store model (Postgres/Neo4j/ClickHouse/blob), unsafe migrations, transaction/locking bugs.',
  'eval-typescript':
    'type-safety holes (any/unsafe casts), async correctness (missing await, unhandled rejection, races), swallowed errors, off-by-one/logic bugs, null/undefined hazards.',
  'eval-types':
    'unsound types that permit invalid states, missing invariants, encapsulation leaks that cause real runtime bugs.',
  'eval-comments':
    'comments that are actively wrong/misleading in a way that drives incorrect usage. Escalate to P0/P1 only when a wrong comment causes a real defect.',
  'eval-architecture':
    'storage-boundary violations, dead/duplicated logic causing divergence, vendor lock, append-only hygiene, layering violations that cause real bugs.',
  'eval-security':
    'secrets in code, SSRF, injection (SQL/command/template), unsafe crypto, authz/authn gaps, tenant isolation breaches, unsafe deserialization, path traversal, missing input validation on trust boundaries.',
  'eval-performance':
    'hot-path inefficiency, N+1, unbounded queries/loops, missing pagination, blocking sync work, redundant fetches, large allocations, missing caching where it matters.',
  'eval-silent-failure':
    'swallowed errors, empty/loose catch blocks, error-to-default fallbacks that mask failures, missing error propagation, ignored promise rejections.',
  'eval-compliance':
    'SOC 2 control gaps, RLS/tenant-scoping gaps, missing audit logging on sensitive actions, encryption-at-rest/in-transit gaps, weak access control.',
  'eval-parity':
    'UI↔API↔MCP capability parity gaps, user-facing actions with no contract/route/tool, stale or missing docs/capabilities entries.',
  'eval-pr-hygiene':
    'red CI on main, unresolved review threads, PRs missing required checks or merged with failing gates.',
  'eval-test-build':
    'coverage below threshold, untested new code, turbo.json cache-key hygiene, build-time regressions, unit/e2e lane separation.',
  'eval-grep':
    'NotImplemented/TODO/FIXME stubs on shipped paths, hardcoded secret patterns, mis-sized infra constants.',
}

const SEVERITY_RUBRIC = `Severity:
- P0 = critical: exploitable security vuln, data loss/corruption, cross-tenant data leak, money/billing miscalculation, crash on a core path, broken auth.
- P1 = high: a real bug with clear user/system impact — missing await, race, unscoped query, incorrect business logic, type unsoundness that throws at runtime, N+1 on a hot path.
- P2 = medium, P3 = low/nit.
Only report something as P0/P1 if you can point to the exact line(s) and explain the concrete failure. Do NOT inflate severity. Style/preference issues are never P0/P1.`

const PROJECT_RULES = `Project rules that matter for severity (CLAUDE.md / engineering policy):
- Four-store model: Postgres=transactional, Neo4j=graph, ClickHouse=append-only events, blob=binary. Wrong store = architecture defect.
- Raw db() is banned; tenant-scoped access must go through withTenantDb/withSystemDb/scopedSession. Missing tenant scoping is a P0/P1 isolation risk.
- All LLM calls must go through @oxagen/ai re-exports (metering). Direct imports from 'ai' in handlers are a defect.
- invoke() requires handler registration; forgetting silently no-ops metering/IAM.
- App code imports UI from @/components/ui/*, never @oxagen/ui/components/* directly.`

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

function reviewPrompt(target, lens) {
  return `You are ${lens}, performing a review of one slice of the Oxagen monorepo.

Slice to review: ${target}
1. Read EVERY source file under that slice path (resolve paths from the repo root). Review them fully.
2. Your lens focus: ${LENS_FOCUS[lens]}
3. ${SEVERITY_RUBRIC}

${PROJECT_RULES}

Report every genuine defect with exact line numbers. Prioritize P0/P1 but include notable P2/P3. If the slice is clean, return an empty findings array. Be precise and conservative on severity — false P0/P1 alarms waste downstream fix effort. In THIS run you are producing findings only; do not edit files (the workflow routes confirmed P0/P1 to a fixer).`
}

function verifyPrompt(f) {
  return `You are an independent, skeptical verifier. ${f.lens} flagged a potential ${f.severity} defect. Confirm or refute it by reading the ACTUAL source — do not trust the claim.

File: ${f.file}  (lines ${f.startLine}-${f.endLine})
Claimed title: ${f.title}
Claimed problem: ${f.problem}
Proposed fix: ${f.fix}

Read the cited file (and any related files needed for context). Then decide:
- isReal: true ONLY if the defect genuinely exists and would cause the stated impact. Default to false if you cannot concretely confirm it.
- severity: your independent re-rating. Downgrade if impact is overstated.
- preciseFix: the exact minimal change to fix it (only if isReal).
${SEVERITY_RUBRIC}
Be rigorous: plausible-but-unconfirmed claims must be isReal=false.`
}

function remediatePrompt(pkg, items) {
  const list = items
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.file}:${f.startLine}-${f.endLine} — ${f.title}\n   Problem: ${f.problem}\n   Fix: ${f.fix}`
    )
    .join('\n')
  return `You are the break-fix agent. Below are independently CONFIRMED P0/P1 defects in ${pkg}. Fix every one, root-cause, in this isolated worktree.

${list}

Rules (from CLAUDE.md and your agent definition):
- Fix the root cause in place plus every co-located instance.
- Add at least one regression test per defect that fails on the old code and passes on the new (Vitest; this package's conventions). Add an apps/app/e2e test ONLY if the defect is on a critical user path.
- Run ONLY the narrow test tied to each change (pnpm --filter <pkg> test:unit -- <file>). NEVER run the whole suite, pnpm test, or turbo run test. Check pgrep -fl vitest and wait rather than stack.
- Group all these ${pkg} fixes onto ONE branch and COMMIT them (regression test in the same commit). Do NOT push — leave the branch committed for Mac to push/PR.
- Write a timestamped report to docs/audits/eval-swarm/<timestamp>-${pkg.replace(/[^a-z0-9]+/gi, '-')}.md and record any worthwhile memory under .oxagen/memories/ (update _index.md if important).

Return a concise summary: branch name, files changed, tests added, the report path, and any defect you could NOT safely fix (with the reason).`
}

// ---------------------------------------------------------------------------

phase('Review')
log(`Slices: ${slices.length}${runRepoLevel ? ' + repo-wide auditors' : ''}. Fix phase: ${runFix ? 'on' : 'off'}.`)

// Per-slice review → verify, pipelined (a slice's P0/P1 verify as soon as its review lands).
const perSlice = await pipeline(
  slices,
  async (slice) => {
    const lenses = slice.kind === 'ui' ? UI_LENSES : CODE_LENSES
    const results = await parallel(
      lenses.map((lens) => () =>
        agent(reviewPrompt(slice.path, lens), {
          label: `${slice.id}:${lens.replace('eval-', '')}`,
          phase: 'Review',
          schema: FINDINGS_SCHEMA,
          agentType: lens,
        }).then((r) => ({ lens, findings: (r && r.findings) || [] }))
      )
    )
    return results
      .filter(Boolean)
      .flatMap((r) => r.findings.map((f) => ({ ...f, lens: r.lens, unit: slice.id })))
  },
  async (findings, slice) => {
    const p01 = (findings || []).filter((f) => f.severity === 'P0' || f.severity === 'P1')
    if (!p01.length) return []
    const verified = await parallel(
      p01.map((f) => () =>
        agent(verifyPrompt(f), {
          label: `verify:${slice.id}:${f.file.split('/').pop()}`,
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

// Repo-wide auditors run once, in parallel, alongside the slice work's results.
let repoFindings = []
if (runRepoLevel) {
  const repo = await parallel(
    REPO_LENSES.map((lens) => () =>
      agent(reviewPrompt('the whole repository (use your auditor’s normal scope)', lens), {
        label: `repo:${lens.replace('eval-', '')}`,
        phase: 'Review',
        schema: FINDINGS_SCHEMA,
        agentType: lens,
      }).then((r) => ({ lens, findings: (r && r.findings) || [] }))
    )
  )
  repoFindings = repo
    .filter(Boolean)
    .flatMap((r) => r.findings.map((f) => ({ ...f, lens: r.lens, unit: 'repo' })))
}

const confirmed = perSlice.filter(Boolean).flat()
log(`Confirmed P0/P1: ${confirmed.length} (from slices) + ${repoFindings.length} repo-wide findings`)

// Group confirmed code-localized defects by package (first two path segments) for grouped remediation.
const byPkg = {}
for (const f of confirmed) {
  if (!/^(packages|apps)\//.test(f.file)) continue
  const pkg = f.file.split('/').slice(0, 2).join('/')
  ;(byPkg[pkg] = byPkg[pkg] || []).push(f)
}

let remediation = []
if (runFix && Object.keys(byPkg).length) {
  phase('Remediate')
  remediation = await parallel(
    Object.entries(byPkg).map(([pkg, items]) => () =>
      agent(remediatePrompt(pkg, items), {
        label: `fix:${pkg}`,
        phase: 'Remediate',
        agentType: 'break-fix',
        isolation: 'worktree',
      }).then((summary) => ({ pkg, count: items.length, summary }))
    )
  )
  remediation = remediation.filter(Boolean)
}

return {
  counts: {
    confirmedP0P1: confirmed.length,
    p0: confirmed.filter((f) => f.severity === 'P0').length,
    p1: confirmed.filter((f) => f.severity === 'P1').length,
    repoFindings: repoFindings.length,
    packagesRemediated: remediation.length,
  },
  confirmed,
  byPkg,
  repoFindings,
  remediation,
}
