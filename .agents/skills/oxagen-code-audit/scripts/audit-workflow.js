export const meta = {
  name: 'oxagen-code-audit',
  description: 'Audit every package/app against .agents/skills engineering law, verify findings, auto-fix safe violations in the worktree',
  phases: [
    { title: 'Audit', detail: 'one auditor per package/app + cross-cutting root, scored against the binding law' },
    { title: 'Verify', detail: 'adversarial verifier kills false positives, re-classifies fix-safety' },
    { title: 'Fix', detail: 'apply only confirmed safe findings, each fixer scoped to its own unit dirs' },
  ],
}

const WT = '/Users/macanderson/oxagen-monorepo-audit'
const SK = WT + '/.agents/skills'
const ENG = SK + '/oxagen-engineering-policy/SKILL.md (and the deeper files under oxagen-engineering-policy/policies/*.md)'
const FP = SK + '/frontend-patterns/SKILL.md (open the matching techniques/*.md)'
const BA = SK + '/better-auth-best-practices/SKILL.md + ' + SK + '/better-auth-security-best-practices/SKILL.md'

const POLICY = `BINDING ENGINEERING LAW (oxagen-engineering-policy) — READ ${ENG} FIRST, then audit against it. Distilled:
NON-NEGOTIABLES (a breach does not merge): (a) Compliance day one — SOC2 always, also PCI DSS + GDPR + HIPAA; design as if an auditor reads every decision. (b) Encryption at rest always; secrets NEVER committed/logged/stored plaintext. (c) Strict types everywhere — no \`any\`, no implicit any, no untyped boundaries; every signature/return/public surface fully typed. (d) Zero warnings = zero errors. (e) PINNED versions — all deps pinned EXACT, NO floating \`^\`/\`~\` ranges. (f) Logging+instrumentation everywhere sensible via the shared telemetry/analytics package. (g) Thin wrappers only — api/cli/mcp are thin shells over packages/, business logic NEVER reproduced in a service. (h) Domain-layer organization — NEVER a flat models/ or routes/ folder. (i) Versioned API — every endpoint versioned. (j) Mobile-first — thumb-navigable outranks desktop.
PRIME DIRECTIVES: move the rock (every PR a complete vertical slice; NO TODO stubs, NotImplementedError, placeholders, commented-out "for later" scaffolding); finish what you touch (schema+api+frontend+tests+docs ship together); no drift (a capability is reachable IDENTICALLY from MCP + HTTP API + in-app agent, defined once in packages/, exposed via thin adapters); prefer DELETING code to adding it.
FOUR STORES, one job each: File/blob -> object storage with a reference row in Postgres. Transactional/relational/required-for-app-to-function + vectors -> Postgres (AlloyDB), the system of record. Agent memory/observations/run-history a customer could carry away -> Neo4j, a PORTABLE knowledge graph that is NEVER load-bearing for core app function (app must run with an empty/BYO graph). High-volume telemetry/analytics for aggregate querying -> ClickHouse, APPEND-ONLY, never a source of truth. Avoid dual writes; a justified mirror is a single-authority one-directional idempotent projection. VIOLATIONS: analytics/aggregation in Neo4j, graph relationships or agent-memory in Postgres, transactional/source-of-truth state in ClickHouse, core app function depending on Neo4j.
SQL: every table UUID \`id\` + human \`public_id\` (usr_/org_…); soft-delete \`deleted_at timestamptz\` ONLY where it earns its place — do NOT reflexively stamp created_at/updated_at/deleted_at on every table (schema-bloat §4); timestamptz UTC named *_at; explicit indexed FKs; money in INTEGER cents or fixed numeric, NEVER floats; forward-only migrations.
BLOAT/SIMPLIFICATION: no dep you can write in ~20 lines; no abstraction before the 3rd repetition; functions do one thing; delete dead code and commented-out blocks; composition over inheritance; one source of truth per concept.
VENDOR NEUTRALITY: business logic never imports a vendor SDK directly — wrap behind an interface in packages/; swapping Stripe / model-provider / queue / sandbox touches ONE adapter.
NAMING/LAYOUT: kebab-case files+dirs; PascalCase React components; tests co-located *.test.ts; shared types in a types module/package, never duplicated.
OBSERVABILITY: structured logs only, NO console.log in shipped paths; no silent catches; metrics (latency/success/failure/retries) on every external call; instrument tokens+exec-time+originating-surface on every agent/LLM/tool call.
TESTS: real assertions per capability; no stubbed asserts; no skipped/.only tests; test the contract not the impl; a bug fix ships a regression test.
BRAND VOICE (user-facing strings): lowercase, calm, precise; no exclamation marks; no emoji in product UI.
PERFORMANCE: no N+1; batch+paginate; deterministic cache w/ explicit invalidation; stream large responses.
SANCTIONED EXCEPTIONS (do NOT flag as violations): documents/* (google+ms docs/sheets/slides + pdf gen) and workspace brand-kit apply are INTENTIONAL console-logging stubs (no throws) per an explicit user decision. Flag them ONLY if such a stub also throws, is untyped, is dead/unwired, or is uninstrumented. A near-empty foundations placeholder app (website hello-world) is also sanctioned — do not flag it as incomplete.`

const FIXCLASS = `fixClass decision (the user chose "auto-fix everything safe AND behavioral; reserve tickets only for the riskiest boundaries"):
auto-fix-safe (apply it) = any change you can make correctly and confidently confined to THIS unit, INCLUDING behavioral/local-logic fixes, as long as it does NOT cross into the reserved boundaries below. Examples: remove dead/commented code, kebab-case renames with no cross-package import breakage, replace \`any\` with precise types, replace console.log with the project logger, surface a silently-swallowed error, add a missing instrumentation call mirroring siblings, fix an N+1 within the unit, extract a duplicated type, fix a brand-voice string, add a missing co-located regression test, fix an obvious logic bug local to the unit, pin a floating dep version to exact.
needs-approval (ticket instead) ONLY for the reserved boundaries: DB schema or migration changes; auth / billing-charging / secrets / encryption / IAM-enforcement logic; four-store boundary MOVES (relocating data between Postgres/Neo4j/ClickHouse); a no-drift change that must be coordinated across MCP+API+app simultaneously to avoid breaking a surface; adding/removing a dependency; or any change whose blast radius you cannot bound to this unit. When a fix would touch one of THESE, file a ticket; otherwise fix it.`

const SCORE = `Also give this unit a healthScore 0-100 (100 = exemplary adherence to the law; 0 = pervasive violation). Weigh non-negotiable, prime-directive, and four-store breaches heaviest.`

const OUT = `Return findings per schema. Each: stable kebab id prefixed by the unit (e.g. "billing-float-money"); precise title; category; severity (critical = non-negotiable/prime-directive/security/four-store breach or a real scale landmine; high = clear policy violation with real cost; medium = meaningful; low = nit); rule (cite the section, e.g. "non-negotiable (e) pinned-versions" or "four-store: ClickHouse append-only" or "prime-directive: no-drift"); file as "relative/path.ts:line"; evidence (quote the actual code/line you saw); recommendation (the specific change); fixClass; effort (XS/S/M/L/XL). Report BOTH violations AND over-engineering / speculative abstraction / premature generality (the user explicitly wants over-engineering flagged) AND future-scale landmines (N+1, unbounded buffering, missing pagination, single-tenant assumptions, sync work on a hot path, dual writes). Be precise and CONSERVATIVE — only what you can evidence with a real file:line. Do not pad. An empty findings list for a clean unit is a valid, valuable result.`

function dirsOf(u) { return u.scope || [u.path] }
function dirList(u) { return dirsOf(u).map(d => WT + '/' + d).join(' , ') }

function auditPrompt(u) {
  return `You audit ONE unit of the Oxagen monorepo (worktree pinned at commit 631f28c) against its binding engineering law. READ-ONLY: do not edit, do not run installs/builds, do not touch git. Work only within ${WT}.

UNIT: ${u.name}  (kind: ${u.kind})
DIRECTORIES YOU OWN: ${dirList(u)}
FOCUS: ${u.focus}

STEP 1 — read the law at ${ENG}. ${u.extraSkills ? 'Also read: ' + u.extraSkills.join(' ; ') + '.' : ''}
STEP 2 — explore your directories thoroughly: list/glob, grep for smells, then READ the high-signal files (entrypoints, exported/public surface, schema + migrations, route/handler/adapter wiring, the largest files, anything that looks churned). For large units prioritize architecture + the public surface + hot paths, but cover the whole unit's shape; do not skip subdirectories.
STEP 3 — evaluate against the law and emit findings.

${POLICY}

${FIXCLASS}

${SCORE}

${OUT}`
}

function verifyPrompt(u, audit) {
  return `Adversarial verifier for UNIT ${u.name}. Another agent produced the findings below. KILL false positives and correctly set fix-safety. READ-ONLY within ${dirList(u)} plus the law at ${ENG}.

For each finding id: open the cited file:line, confirm the evidence is real and the rule citation correct, then set:
- verdict: "confirmed" (real evidence AND genuine violation / genuine over-engineering / genuine scale risk), "false-positive" (misread, sanctioned exception, rule misapplied, or not actually wrong), or "uncertain" (plausible but unconfirmable from the code).
- fixClass: re-decide INDEPENDENTLY using: ${FIXCLASS}  An "uncertain" verdict must NOT be auto-fix-safe.
- severity: confirm or correct.
- reasoning: 1-2 sentences citing what you actually saw.
Be skeptical: if you cannot stand a finding up against the real code, mark it false-positive or uncertain. A wrong auto-fix is the expensive outcome.

FINDINGS (JSON):
${JSON.stringify(audit.findings)}`
}

function fixPrompt(u, fixes) {
  return `Apply ONLY these pre-approved, confirmed, safe fixes to UNIT ${u.name} in the worktree. Edit files ONLY under: ${dirList(u)}. Do NOT run installs/builds/tests/git. Make NO change beyond the listed fixes. Do NOT touch DB schema/migrations, auth/billing-charge/secrets/encryption/IAM-enforcement logic, dependency add/remove, or cross-surface no-drift wiring — if a listed fix would require any of that, SKIP it and record why. Preserve surrounding style exactly. If the cited code no longer matches or a fix looks unsafe on close inspection, SKIP it.

Return applied[] (id, files touched, one-line edit summary) and skipped[] (id, reason).

CONFIRMED SAFE FIXES (JSON — apply exactly these):
${JSON.stringify(fixes.map(f => ({ id: f.id, title: f.title, file: f.file, recommendation: f.recommendation, evidence: f.evidence })))}`
}

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['unit', 'summary', 'healthScore', 'findings'],
  properties: {
    unit: { type: 'string' }, summary: { type: 'string' }, healthScore: { type: 'integer', minimum: 0, maximum: 100 },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'title', 'category', 'severity', 'rule', 'file', 'evidence', 'recommendation', 'fixClass', 'effort'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          category: { type: 'string', enum: ['scale', 'architecture', 'over-engineering', 'policy-violation', 'security', 'data-model', 'instrumentation', 'tests', 'bloat', 'naming', 'vendor', 'performance', 'brand', 'no-drift', 'types', 'compliance'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          rule: { type: 'string' }, file: { type: 'string' }, evidence: { type: 'string' }, recommendation: { type: 'string' },
          fixClass: { type: 'string', enum: ['auto-fix-safe', 'needs-approval'] },
          effort: { type: 'string', enum: ['XS', 'S', 'M', 'L', 'XL'] },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['unit', 'verdicts'],
  properties: {
    unit: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'verdict', 'fixClass', 'severity', 'reasoning'],
        properties: {
          id: { type: 'string' }, verdict: { type: 'string', enum: ['confirmed', 'false-positive', 'uncertain'] },
          fixClass: { type: 'string', enum: ['auto-fix-safe', 'needs-approval'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, reasoning: { type: 'string' },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['unit', 'applied', 'skipped'],
  properties: {
    unit: { type: 'string' },
    applied: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'files', 'summary'], properties: { id: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } } },
    skipped: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } } },
  },
}

const UNITS = [
  { name: 'pkg-oxagen', path: 'packages/oxagen', kind: 'package', focus: 'The capability-contract + no-drift CORE (~4.5k loc). Verify each capability is defined ONCE and the generated contracts (contracts.generated.ts) stay in sync with hand-written contracts and the capabilities.manifest.json; that MCP/API/app all consume this one definition (no-drift); speculative abstraction/over-generation; instrumentation of the invoke boundary; types not duplicated.' },
  { name: 'pkg-agent', path: 'packages/agent', kind: 'package', focus: 'Agent runtime (~3.6k loc). Look for instrument-everything coverage (tokens+time+surface on every LLM/tool call), single-AI-chokepoint adherence, vendor-neutral model access, over-engineering/premature abstraction, dead code, hot-path sync work, unbounded buffering of agent steps.' },
  { name: 'pkg-database', path: 'packages/database', kind: 'package', focus: 'Schema + migrations + drizzle (~3.4k loc). Enforce SQL conventions: UUID id + public_id; soft-delete deleted_at ONLY where justified (flag reflexive lifecycle columns as schema-bloat §4 AND flag missing public_id/soft-delete where it IS needed); timestamptz *_at; explicit indexed FKs; money integer cents never float; forward-only migrations; four-store boundaries (NO analytics tables, NO graph/agent-memory tables in Postgres); duplicated type/enum definitions.' },
  { name: 'pkg-billing', path: 'packages/billing', kind: 'package', focus: 'Billing (~2.4k loc). Money MUST be integer cents never floats; credit model (1 credit = 1 cent); margin realized at the meter (solved markup) not sticker; pricing.ts is the single source of truth; Stripe wrapped behind an adapter (vendor neutrality — business logic must not import stripe SDK directly); billing tables have public_id + soft-delete; instrumentation; tiers + credit-expiry-by-source logic correctness.' },
  { name: 'pkg-handlers', path: 'packages/handlers', kind: 'package', focus: 'Capability handlers (~1.9k loc). Each handler: routed through the single invoke/AI chokepoint, instrument-everything (tokens+time+surface), no-drift (same handler powers MCP+API+app), sanctioned doc/brandkit stubs held to guardrails (typed,no-throw,wired,instrumented), vendor-neutral, no console.log, real-assertion tests co-located.' },
  { name: 'pkg-sandbox', path: 'packages/sandbox', kind: 'package', focus: 'Code-execution sandbox (~1.4k loc) — SECURITY-SENSITIVE. Check isolation boundaries, no secret leakage into sandboxed code, resource limits (timeout/memory/output caps to prevent DoS), vendor-neutral provider wrapping, instrumentation, error handling not silently swallowed.' },
  { name: 'pkg-auth', path: 'packages/auth', kind: 'package', focus: 'Better Auth (~1.4k loc) — SECURITY. Check session/secret handling (no secrets in client, no secrets logged), rate limiting, trusted origins/CSRF, cookie security, token encryption, vendor-neutral wrapping, instrumentation. Compliance posture (SOC2/GDPR).', extraSkills: [BA] },
  { name: 'pkg-ai', path: 'packages/ai', kind: 'package', focus: 'The single AI chokepoint (~1.2k loc): stream/generate-object/embed/models. Verify ALL AI work enters/exits ONE invoke() boundary for metering/perf/IAM/customer-hooks (single-ai-chokepoint); instrument-everything wired here (tokens+time+surface); vendor-neutral model provider seam (swapping providers touches one adapter); over-engineering; generateObject powers the ask-bar form-fill correctly.' },
  { name: 'pkg-telemetry', path: 'packages/telemetry', kind: 'package', focus: 'The instrument-everything + ClickHouse package (~0.8k loc): client.ts, clickhouse.ts, schema.sql, migrations, security.ts. Verify ClickHouse is APPEND-ONLY and never used as a source of truth (four-store); the shared instrumentation API actually captures tokens+exec-time+originating-surface and is the ONE path other packages call; no transactional state here; secrets handling; schema.sql conventions; security.test real assertions.' },
  { name: 'pkg-inngest-functions', path: 'packages/inngest-functions', kind: 'package', focus: 'Background jobs (~0.7k loc). Vendor-neutral queue/runner seam (swapping Inngest touches one adapter), idempotency, instrumentation, no business logic that belongs in another package, dead/speculative functions, error handling + retries.' },
  { name: 'pkg-iam', path: 'packages/iam', kind: 'package', focus: 'Access control (~0.7k loc): check-iam, fetch-authz, access-request, denial, emit-audit, bootstrap. CRITICAL: verify IAM is actually WIRED and ENFORCED on live paths (it was previously dormant — confirm setIAMRuntime is invoked at API+MCP surfaces and checks run before capability execution), audit events are emitted (emit-audit) to the append-only store, deny-by-default posture, no bypass, full typing, real tests.' },
  { name: 'pkg-skills', path: 'packages/skills', kind: 'package', focus: 'Skills package (~0.6k loc). Check for dead/speculative code, duplicated types, instrumentation, one-source-of-truth (skills-lock.json + db seed), vendor neutrality, naming.' },
  { name: 'pkg-crypto', path: 'packages/crypto', kind: 'package', focus: 'Crypto (~0.5k loc) — encryption-at-rest is a NON-NEGOTIABLE. Verify primitives are sound (no homemade crypto, AEAD usage, key handling, no hardcoded keys/IVs, secrets never logged), fully typed, real tests, and that this is the single seam other packages use to encrypt persisted data.' },
  { name: 'pkg-ontology', path: 'packages/ontology', kind: 'package', focus: 'Neo4j/graph layer (~0.4k loc). Four-store: graph relationships + agent memory ONLY; verify it is NOT load-bearing for core app function (app must run with empty/BYO graph); no analytics/aggregation that belongs in ClickHouse; no transactional state that belongs in Postgres; instrumentation; vendor-neutral driver seam.' },
  { name: 'pkg-config-ui', path: 'packages/config', scope: ['packages/config', 'packages/ui'], kind: 'package', focus: 'packages/config (~0.2k loc: env.ts normalizing double-quoted dev env values — verify it is the SINGLE source of truth for env loading) AND packages/ui (~22 loc, near-empty — determine: intentional shared-UI seed or dead/speculative scaffolding to trim?). Flag premature abstraction or dead exports in either.' },
  { name: 'app-api', path: 'apps/api', kind: 'app', focus: 'HTTP API (~0.6k loc) — MUST be a THIN adapter over packages/ with NO business logic leaking in. Verify: every endpoint is VERSIONED (/v1/…), domain-layer org (no flat routes/ dump), no-drift parity with MCP+app, IAM enforcement actually invoked on the live request path, instrumentation + structured logs (no console.log), no silent catches.' },
  { name: 'app-mcp', path: 'apps/mcp', kind: 'app', focus: 'MCP server (~0.7k loc) — THIN adapter. Verify no-drift parity: every capability exposed here mirrors API+app exactly from packages/; IAM runtime wired (setIAMRuntime) and enforced; instrumentation with originating-surface=mcp; no business logic reproduced; thin registration only.' },
  { name: 'app-app-routes', path: 'apps/app/src/app', scope: ['apps/app/src/app', 'apps/app/src/proxy.ts'], kind: 'app', focus: 'Next.js App Router routes/server half (~3.4k loc) + proxy.ts. Verify: request interception is proxy.ts NOT middleware.ts (Next 16); App Router + RSC + streaming built on the Vercel AI SDK with no parallel transport; server actions for mutations; auth in server components only (client NEVER sees session tokens); the chat/stream route handler is thin + instrumented; versioned + no-drift; mobile-first. Apply frontend-patterns to any server-rendered UI/copy; brand voice on user-facing strings.', extraSkills: [FP] },
  { name: 'app-app-components', path: 'apps/app/src/components', kind: 'app', focus: 'Next.js React components (~6.3k loc): auth, billing, chat, org, shell, ui, workspace. AUDIT: frontend-patterns (a11y, Core Web Vitals/INP, forms/autofill for the ask-bar generative form-fill, passkeys), brand voice (lowercase calm, no exclamation/emoji), mobile-first thumb-nav, over-engineering in the chat-component-registry/stream layer, duplicated types, no \`any\`, low-balance/auto-reload UX correctness.', extraSkills: [FP] },
  { name: 'app-app-lib', path: 'apps/app/src/lib', kind: 'app', focus: 'Next.js app client/server libs + hooks + state (~1.7k loc). Check: no business logic that belongs in packages/ (thin app), types not duplicated (extract shared), no \`any\`, no console.log, instrumentation of client tool-stream, no secrets reaching the client, dead code, over-abstraction.' },
  { name: 'app-misc', path: 'apps/admin', scope: ['apps/admin', 'apps/website', 'apps/cli', 'apps/docs'], kind: 'app', focus: 'Four small/near-empty apps: admin (~43 loc), website (~43 loc, a SANCTIONED hello-world foundations placeholder — do not flag as incomplete), cli (~59 loc), docs (~141 loc). For EACH determine: intentional foundations placeholder vs dead/speculative scaffolding to trim. Flag premature structure, dead deps, and (for admin/website UI) brand-voice issues if any UI exists.' },
  { name: 'xcut-root', path: '.', kind: 'cross-cutting', focus: 'MONOREPO-WIDE only (do NOT re-audit package internals): (1) DEPENDENCY VERSION PINNING — non-negotiable (e) says pin EXACT, no floating ^/~ ranges; scan EVERY package.json across packages/* and apps/* (root is already pinned) and flag any ^/~ ranges, and flag any dep whose version differs across workspaces (one-latest-stable-per-dep). (2) turbo.json pipeline sanity + tsconfig.base.json + vercel.json + vitest.workspace.ts coherence; pnpm-workspace globs. (3) CI: .github/workflows/ci.yml + release.yml — confirm typecheck/migrate/test gate runs on pull_request (the policy + user rule: CI gate only on PRs, NOT direct main pushes); flag if a heavy job runs on every main push (burns Vercel budget). (4) FOUR-STORE boundary scan repo-wide (grep for analytics/aggregation against neo4j, graph writes against postgres, source-of-truth reads from clickhouse). (5) NO-DRIFT wiring check across apps/api + apps/mcp + apps/app at the registration level. (6) repo-wide DEAD CODE + duplicated type definitions + commented-out scaffolding. Read root configs under ' + WT + ' and ' + WT + '/.github/workflows.' },
]

phase('Audit')
log(`auditing ${UNITS.length} units against the engineering law @ 631f28c`)

const results = await pipeline(
  UNITS,
  (u) => agent(auditPrompt(u), { label: `audit:${u.name}`, phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'sonnet' }),
  async (audit, u) => {
    if (!audit) return null
    const verify = (audit.findings && audit.findings.length)
      ? await agent(verifyPrompt(u, audit), { label: `verify:${u.name}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' })
      : { unit: u.name, verdicts: [] }
    return { unit: u.name, path: u.path, audit, verify: verify || { unit: u.name, verdicts: [] } }
  },
  async (merged, u) => {
    if (!merged) return null
    const vmap = new Map((merged.verify.verdicts || []).map(v => [v.id, v]))
    const confirmedSafe = (merged.audit.findings || []).filter(f => {
      const v = vmap.get(f.id)
      return v && v.verdict === 'confirmed' && v.fixClass === 'auto-fix-safe'
    })
    let fix = { unit: u.name, applied: [], skipped: [] }
    if (confirmedSafe.length) {
      fix = await agent(fixPrompt(u, confirmedSafe), { label: `fix:${u.name}`, phase: 'Fix', schema: FIX_SCHEMA, model: 'sonnet' }) || fix
    }
    return { ...merged, fix }
  }
)

const flat = results.filter(Boolean)

const allFindings = flat.flatMap(r => (r.audit.findings || []).map(f => {
  const v = (r.verify.verdicts || []).find(x => x.id === f.id) || {}
  const appliedIds = new Set((r.fix.applied || []).map(a => a.id))
  return {
    ...f, unit: r.unit,
    verdict: v.verdict || 'unverified',
    verifiedFixClass: v.fixClass || f.fixClass,
    verifiedSeverity: v.severity || f.severity,
    verifyReasoning: v.reasoning || '',
    applied: appliedIds.has(f.id),
  }
}))

const countBy = (arr, key) => arr.reduce((m, x) => { const k = x[key]; m[k] = (m[k] || 0) + 1; return m }, {})
const confirmed = allFindings.filter(f => f.verdict === 'confirmed')
const tickets = confirmed.filter(f => f.verifiedFixClass === 'needs-approval')
const fixesApplied = flat.flatMap(r => (r.fix.applied || []).map(a => ({ ...a, unit: r.unit })))
const fixesSkipped = flat.flatMap(r => (r.fix.skipped || []).map(a => ({ ...a, unit: r.unit })))

const rollup = {
  units: flat.length, totalFindings: allFindings.length,
  confirmed: confirmed.length,
  falsePositive: allFindings.filter(f => f.verdict === 'false-positive').length,
  uncertain: allFindings.filter(f => f.verdict === 'uncertain').length,
  bySeverityConfirmed: countBy(confirmed, 'verifiedSeverity'),
  byCategoryConfirmed: countBy(confirmed, 'category'),
  fixesApplied: fixesApplied.length, fixesSkipped: fixesSkipped.length, ticketsNeeded: tickets.length,
}

log(`audit complete: ${confirmed.length} confirmed of ${allFindings.length} raw; ${fixesApplied.length} auto-fixed; ${tickets.length} need approval`)

return {
  meta: { base: '631f28c', worktree: WT, branch: 'audit/codebase-2026-05-31', generatedFor: 'oxagen-monorepo' },
  unitSummaries: flat.map(r => ({ unit: r.unit, healthScore: r.audit.healthScore, summary: r.audit.summary, findingCount: (r.audit.findings || []).length, confirmedCount: (r.verify.verdicts || []).filter(v => v.verdict === 'confirmed').length, applied: (r.fix.applied || []).length })),
  rollup, findings: allFindings, fixesApplied, fixesSkipped, tickets,
}
