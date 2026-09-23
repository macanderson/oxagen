export const meta = {
  name: 'mc-4-run-evidence',
  description: 'Rev1 app session 4: a Proof tab over the proof handler that already ships, run export status and download, gateway outcomes (budget refusal, interrupt, routed tier) visible in the transcript, and the unmetered-runs caveat and cache tile on Spend; one PR',
  whenToUse: 'Run after mc-1-decide-and-act (it extends the Run tabs and the Fleet caveat). Advances #2952, #2955 (the buildable slice only), #3304.',
  phases: [
    { title: 'Scout', detail: 'confirm each lane is still open on main' },
    { title: 'Build', detail: 'three lanes in parallel worktrees' },
    { title: 'Integrate', detail: 'merge lanes, open the PR, drive CI green' },
    { title: 'Review', detail: 'cold review; fix P0 and P1; residue issue for the rest' },
  ],
}

// ---------------------------------------------------------------------------
// Shared preamble. Every mc-* workflow carries an identical copy because a
// workflow script cannot import another file. Edit
// oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md §"Workflow shape"
// when you change it, and change every copy.
// ---------------------------------------------------------------------------

const RULES = `
HARD RULES for this repository. Restate them to any subagent you spawn.
- Local verification is limited to ONE test file for code you changed, run in isolation:
  pnpm --filter @oxagen/<package> test:unit path/to/changed.test.ts   (never put "--" before the path).
  Never run a package-wide suite, pnpm gate, lint, typecheck, or a build. CI on the PR is the gate.
- Never commit or push to main. Never git stash. Never rebase, amend, or force-push a pushed branch. Use git merge.
- Start from fresh refs: git fetch origin. Branch from the base named in your task. Push -u immediately. Commit and push after every step. Sessions die; unpushed work is lost.
- Load .claude/skills/clear-prose before writing UI strings, comments, commit messages, or PR bodies (no em dashes, no exclamation points, sentence case). Load oxagen-app-conventions, quality-gates, and oxagen-testing before UI work. Load oxagen-capability-contracts and oxagen-surface-patterns before touching a contract.
- Parity is one change: contract -> API route -> MCP tool -> CLI (when the surface lists it) -> docs/capabilities/<stem>.md -> apps/app/capability-ui-map.json binding with a component or action test as its proof. Adding "app" to a contract's layers without a binding, a page, and a proof fails check:ui-parity --strict.
- Every UI state from quality-gates: loaded, empty, loading, error, denied, phone width. Every new component and server action gets a co-located test.
- Generators are allowed and required when their --check fails: pnpm --filter @oxagen/app gen:messages (messages.d.ts) and pnpm docs:schemas. Commit their output.
- Every badge that describes trust (enforcement tier, replay grade, attestation, cost basis) shows the recorded value and nothing stronger. Every money figure shows its basis. Where the backend has not shipped, render the NotBacked state, never a placeholder value.
- Read DEREGISTERED.md before removing anything. De-registering is not deleting.
- Fix any defect you meet in the files you touch (SCR-004) and name it in the PR body. File an issue only when a fix cannot ride the PR, with only the triage label, one full change per issue, and a "- [ ]" definition of done.
- GitHub: use the gh CLI if it is installed, else the GitHub MCP tools (load with ToolSearch). Never assume either.
- Do not add a fourth Playwright spec. apps/app/e2e holds login, pay, and page-load only. New routes go in apps/app/e2e/routes.ts for page-load.
`

const CONTEXT = `
oxagen-roadmap:<path> means <path> in https://github.com/macanderson/oxagen-roadmap (the build plan, the gap inventory, and the product spec moved there on 2026-09-23, #3895). Read it from a checkout beside this repository (~/Projects/oxagen-roadmap, or ../oxagen-roadmap in a cloud session); a change to those files is a pull request in that repository.
CONTEXT you must read before editing (paths relative to the repo root):
- oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md: the session plan and the corrected gap facts. Your session's section names your lane and what is already built.
- oxagen-roadmap:docs/oxagen/audits/2026-09-19-mission-control-gap-inventory-review.md: why the older gap inventory is stale. Do not rebuild anything §1 there marks Built.
- apps/app/ARCHITECTURE.md §1.2 (the page set and what each page reads), §3 (viewer, kernel, ports, mappers, SSE, not recorded), §4 (invariants), §6 (testing).
- oxagen-roadmap:docs/mission-control-spec.md §14 (the page table), and the section your lane names.
- apps/app/capability-ui-map.json: the enforced binding of every app-layer capability to a page and a proof. Diff against it first, the spec second.
The app: routes under apps/app/src/app/[org]/..., feature lanes under apps/app/src/features/<page>/, view models under apps/app/src/data/contracts/, live adapters and mappers under apps/app/src/data/live/, the UI kit under apps/app/src/ui/ imported as @/ui/<name>, messages under apps/app/messages/. Server writes go through the kernel seam in apps/app/src/server/kernel.ts, never a raw invoke.
`

const RESULT_FIELDS = {
  type: 'object',
  properties: {
    lane: { type: 'string' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    head_sha: { type: 'string' },
    pr_url: { type: 'string' },
    ci_state: { type: 'string', description: 'green | red | pending | not-opened' },
    summary: { type: 'string' },
    files_touched: { type: 'array', items: { type: 'string' } },
    capabilities_bound: { type: 'array', items: { type: 'string' }, description: 'capability names given an app binding in this lane' },
    spec_deviations: { type: 'array', items: { type: 'string' } },
    open_gaps: { type: 'array', items: { type: 'string' } },
    defects_fixed: { type: 'array', items: { type: 'string' } },
  },
}

const LANE_RESULT = {
  ...RESULT_FIELDS,
  required: ['lane', 'branch', 'head_sha', 'summary', 'ci_state', 'open_gaps'],
}
const INTEGRATION_RESULT = {
  ...RESULT_FIELDS,
  required: ['branch', 'head_sha', 'pr_url', 'summary', 'ci_state', 'open_gaps'],
}
const REMOTE_HEAD = {
  type: 'object',
  properties: { branch: { type: 'string' }, head_sha: { type: 'string' }, exists: { type: 'boolean' } },
  required: ['branch', 'head_sha', 'exists'],
}

function validLane(result) {
  return result && typeof result.branch === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(result.branch)
    && !result.branch.includes('..') && !result.branch.includes('//')
    && !result.branch.endsWith('/') && !result.branch.endsWith('.')
    && !result.branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
    && /^[a-f0-9]{40}$/.test(result.head_sha || '')
}


const SCOUT = {
  type: 'object',
  properties: {
    base_sha: { type: 'string' },
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          still_open: { type: 'boolean', description: 'false when main already ships what the lane would build' },
          facts: { type: 'string', description: 'file:line facts the lane builder needs; what exists, what is missing' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'still_open', 'facts'],
      },
    },
    open_prs: { type: 'array', items: { type: 'string' }, description: 'open PRs on main that overlap these lanes, with state' },
  },
  required: ['base_sha', 'lanes'],
}

const REVIEW = {
  type: 'object',
  properties: {
    pr_url: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, file: { type: 'string' }, finding: { type: 'string' } }, required: ['severity', 'finding'] } },
    ci_state: { type: 'string' },
    residue_issue: { type: 'string', description: 'URL of the residue issue if one was filed' },
  },
  required: ['fixed', 'remaining', 'ci_state'],
}

const cfg = Object.assign({
  worktreeRoot: '../oxagen-worktrees',
  skipLanes: [],
  dryRun: false,
  mergeMain: true,
}, args || {})

function wt(slug) { return `${cfg.worktreeRoot}/${slug}` }

function scoutPrompt(session, lanes) {
  return `${RULES}\n${CONTEXT}
TASK: Scout for session ${session.id} (${session.title}). Read-only. Do not edit or create files.
1. git fetch origin. Record origin/main's sha.
2. For each lane below, check origin/main for what the lane would build. Report still_open=false when it already ships (a route, a component, a binding in capability-ui-map.json, a contract). Cite file:line facts the builder needs: the existing components to extend, the contract name and its input shape, the mapper that drops a field, the message namespace, the test file beside the component.
3. List open PRs whose diff overlaps a lane's paths (gh pr list, or the GitHub MCP list_pull_requests on macanderson/oxagen) with their state, so a lane can branch from or wait on them.
Lanes: ${JSON.stringify(lanes.map(l => ({ id: l.id, title: l.title, owns: l.owns, checks: l.checks })))}
Return the structured result only.`
}

function lanePrompt(session, lane, scoutFacts, base) {
  return `${RULES}\n${CONTEXT}
TASK: Lane ${lane.id} of session ${session.id} (${session.title}): ${lane.title}.
Scout facts for this lane (verify before relying on them): ${scoutFacts || 'none'}
Issues: ${(lane.issues || []).join(', ') || 'none'}. Use Refs #N in commits; the integrator decides Closes.
1. git -C <repo> fetch origin && git worktree add ${wt(session.id + '-' + lane.id)} -b mc/${session.id}-${lane.id} ${base}; push -u immediately.
2. You own ONLY these paths: ${lane.owns.join(', ')}. Shared files (messages/en.json outside your namespace, capability-ui-map.json, data/contracts/*, data/ports.ts) may be edited only in the smallest hunk your lane needs, in its own block, so the integrator can merge sibling lanes.
3. Build: ${lane.task}${lane.integrate === false ? '\nThis lane is a sidecar: its branches are not merged into the session PR. Return the branch you worked on and the per-target results in summary and open_gaps.' : ''}
4. Done when: ${lane.done}
5. Tests beside every component and action. Run at most one changed test file in isolation. Commit and push after every step. Do not open a PR; the integrator does.
Return the structured result (ci_state: not-opened).`
}

function integratePrompt(session, built, base) {
  return `${RULES}\n${CONTEXT}
TASK: Integrate session ${session.id} (${session.title}) into one PR.
1. git fetch origin && git worktree add ${wt(session.id)} -b mc/${session.id} ${base}; push -u.
2. git merge (never rebase) each verified lane commit: ${built.map(b => `${b.head_sha} (refs/heads/${b.branch})`).join(', ')}. Verify each fetched remote branch still points to its reported SHA before merging; stop on a mismatch. Resolve conflicts in messages, capability-ui-map.json, data/contracts, and ports by keeping both lanes' hunks. ${cfg.mergeMain ? 'Then merge origin/main.' : ''}
   Lane summaries: ${JSON.stringify(built.map(b => ({ lane: b.lane, branch: b.branch, summary: b.summary, gaps: b.open_gaps, deviations: b.spec_deviations })))}
3. Read the combined diff once, end to end, against oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md §${session.id} and the spec sections it names. Fix anything missing or inconsistent. Run the generators whose --check would fail (gen:messages, docs:schemas) and commit their output. Update apps/app/e2e/routes.ts for any new route.
4. Update apps/app/ARCHITECTURE.md §1.2 rows the session changes, and tick the session's "Done when" boxes in oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md that are now true. Commit and push.
5. Open a PR against main, ready for review, titled "${session.prTitle}". Body per .github/PULL_REQUEST_TEMPLATE.md: what ships and each defect that rode along, exactly one issue line (Closes #N only when the issue's whole DoD is done, otherwise Refs #N, otherwise the closes-nothing label), vision alignment, checklist, verification. ${session.issueHint} Then add the one-line "Landed in PR <url>" note under the session's heading in BUILD-CHUNKS.md, commit, and push.
6. Watch CI. A conflicting PR gets no run, so merge main. Fix every failure and push, up to four rounds. Report exactly what still fails if red. Do not merge the PR.
7. Remove the lane worktrees (git worktree remove, then prune). Keep the integration worktree.
Return the structured result with pr_url, head_sha, ci_state.`
}

function reviewPrompt(session, pr, specHint) {
  return `${RULES}\n${CONTEXT}
TASK: Cold review of PR ${pr.pr_url} (branch ${pr.branch}, worktree ${pr.worktree || wt(session.id)}) for session ${session.id} (${session.title}).
Review against: ${specHint}. Check spec fidelity (states, copy, entry points), tenancy and IAM on every new handler or action (withTenantDb, assertOrgRole where an org role is required), capability parity and the ui-map binding with a real proof file, every trust badge honest to the record, a test beside every new component and action, and clear-prose on every string.
Fix every P0 and P1 you confirm directly on the branch, commit, push, and watch CI green again (up to three rounds). Carry P2 and below into one residue issue by default; split genuinely unrelated changes so each issue has exactly one kind, one job, and one full change per DoD (SCR-003). Title each issue "Residue from #<PR>: <what is left>" with each finding verbatim, its file and line, why it matters, the pillar it moves, and a "- [ ]" DoD; apply only the triage label. Then, per AGENTS.md (Residue merges), reply on every carried thread that the finding stands and names the residue issue, and resolve that thread: resolving is an acceptance, not a dismissal. Leave a P0 or P1 thread open only if you could not fix it, and say why on the thread. Return what you fixed, what remains with severities, the residue issue URL, and the final ci_state.`
}

async function runSession(session, specHint) {
  phase('Scout')
  const scout = await agent(scoutPrompt(session, session.lanes), { label: `scout:${session.id}`, phase: 'Scout', schema: SCOUT, agentType: 'general-purpose' })
  if (!scout) { log('scout failed; stopping'); return { session: session.id, error: 'scout failed' } }
  const base = session.base || 'origin/main'
  const active = session.lanes.filter(l => {
    if (cfg.skipLanes.includes(l.id)) { log(`lane ${l.id} skipped by args`); return false }
    const s = scout.lanes.find(x => x.id === l.id)
    if (s && !s.still_open) { log(`lane ${l.id} already shipped on main: ${s.facts}`); return false }
    return true
  })
  if (!active.length) { log('nothing left to build'); return { session: session.id, scout, built: [] } }
  if (cfg.dryRun) { log('dry run: returning scout only'); return { session: session.id, scout, would_build: active.map(l => l.id) } }

  phase('Build')
  const reported = (await parallel(active.map(l => () => agent(
    lanePrompt(session, l, (scout.lanes.find(x => x.id === l.id) || {}).facts, base),
    { label: `lane:${l.id}`, phase: 'Build', schema: LANE_RESULT, agentType: 'general-purpose' },
  )))).filter(Boolean)
  const built = []
  for (const result of reported) {
    const assigned = active.find(l => l.id === result.lane)
    if (!validLane(result) || !active.some(l => l.id === result.lane)
      || (assigned.integrate !== false && result.branch !== `mc/${session.id}-${result.lane}`)
      || reported.filter(other => other.lane === result.lane || other.branch === result.branch || other.head_sha === result.head_sha).length !== 1) {
      log('invalid or duplicate lane result; stopping before integration')
      return { session: session.id, scout, error: 'invalid lane result', reported }
    }
    const remote = await agent(
      `Read-only verification. Run git ls-remote --heads origin refs/heads/${result.branch} in the repository. Return exists=false if absent or the command fails; otherwise return the fully qualified remote ref (refs/heads/<branch>) in branch and the 40-character head SHA. Do not edit files or push.`,
      { label: `verify:${result.lane}`, phase: 'Build', schema: REMOTE_HEAD, agentType: 'general-purpose' },
    )
    if (!remote || !remote.exists || remote.branch !== `refs/heads/${result.branch}` || remote.head_sha !== result.head_sha) {
      log(`lane ${result.lane} has no matching remote head; stopping before integration`)
      return { session: session.id, scout, error: 'remote head mismatch', reported }
    }
    built.push(result)
  }
  const failed = active.filter(l => !built.find(b => b.lane === l.id)).map(l => l.id)
  if (failed.length) {
    log(`lanes that returned nothing: ${failed.join(', ')}; stopping before integration`)
    return { session: session.id, scout, built, failed, error: 'missing lane result' }
  }
  // A lane with integrate: false works on branches that are not this session's
  // (an existing PR, a maintenance task). Its result is reported, never merged.
  const sidecar = built.filter(b => (session.lanes.find(l => l.id === b.lane) || {}).integrate === false)
  const mergeable = built.filter(b => !sidecar.includes(b))
  if (sidecar.length) log(`sidecar lanes kept out of integration: ${sidecar.map(b => b.lane).join(', ')}`)
  if (!mergeable.length) return { session: session.id, scout, built: [], sidecar, failed }

  phase('Integrate')
  const pr = await agent(
    integratePrompt(session, mergeable, base),
    { label: `integrate:${session.id}`, phase: 'Integrate', schema: INTEGRATION_RESULT, agentType: 'general-purpose' },
  )
  if (!validLane(pr) || !pr.pr_url) return { session: session.id, scout, built: mergeable, sidecar, failed, pr }

  phase('Review')
  const review = await agent(reviewPrompt(session, pr, specHint), { label: `review:${session.id}`, phase: 'Review', schema: REVIEW, agentType: 'general-purpose' })
  return { session: session.id, scout, built: mergeable, sidecar, failed, pr, review }
}

const session = {
  id: '4',
  title: 'Run evidence: proof, export download, gateway outcomes, spend honesty',
  prTitle: 'Oxagen app: the Proof tab, run export download, gateway outcomes on the transcript, and unmetered runs named beside every total',
  issueHint: 'Refs #2952, #2955, #3304, #3299. Closes #3304 only if its whole DoD is done. Never claim proof beyond what get_run_proof records.',
  lanes: [
    {
      id: 'proof', title: 'Proof tab on Run over get_run_proof',
      owns: ['apps/app/src/features/run/run.tsx (tab list hunk)', 'apps/app/src/features/run/proof*.tsx (new) and tests', 'apps/app/src/data/contracts/run.ts (proof view block)', 'apps/app/src/data/live/runs.ts and mappers (proof read)', 'apps/app/src/data/ports.ts (proof read)', 'apps/app/messages/run.json (proof keys block)', 'packages/oxagen/src/contracts/run.proof.get.ts (surfaces and layers)', 'apps/mcp/src/tools/run.proof.get.ts (new, if the parity check requires mcp for app-layer contracts)', 'apps/app/capability-ui-map.json (get_run_proof)'],
      checks: ['run.tsx TABS = transcript, frames, cost, chain, approvals; no proof', 'get_run_proof (run.proof.get.ts ~74) surfaces ["api"], handler registered, no app import, no binding', 'header.tsx ~228-235 prints only "witnessed"'],
      issues: ['#2955'],
      task: `Add a Proof tab that renders exactly what get_run_proof returns: the verdict word, the witness (witnessFor), the oracles and their results, and the frames each result cites as links into the Frames tab. Certificate, checks, Stops, and signing a human check have no contract: render one NotBacked line for them naming Phase 5 and #2955, and nothing else. Read spec §8.5 for the words; "proven" is the witness's word and appears only when the record says it. Add "app" (and "mcp" plus a thin MCP tool if check_manifest requires it) to the contract, bind it with the tab's test as proof.`,
      done: 'The Proof tab shows the recorded proof for a witnessed run and the NotRecorded state for one without; the Phase 5 items render as one NotBacked line; tests cover both.',
    },
    {
      id: 'export', title: 'Run export status and download',
      owns: ['packages/oxagen/src/contracts/run.export.get.ts (new: get_run_export)', 'packages/oxagen/src/contracts/index.ts (barrel line)', 'packages/handlers/src/run.export.get.ts (new) and test', 'packages/handlers/src/register.ts (one line)', 'apps/api/src/routes/v1/run.export.get.ts (new) and the download route', 'apps/mcp/src/tools/run.export.get.ts (new)', 'apps/cli/src/commands/run.ts (export status subcommand)', 'docs/capabilities/run.export.get.md and _index.md', 'apps/app/src/app/[org]/[ws]/runs/[run]/export/[exportId]/route.ts (new)', 'apps/app/src/features/run/record-actions.tsx (export hunk) and tests', 'apps/app/src/data/live/runs.ts (export read)', 'apps/app/messages/run.json (export keys block)', 'apps/app/capability-ui-map.json (get_run_export)'],
      checks: ['export_run returns {exportId, status:"queued"} and its API route is POST only', 'the job writes bundleRef to evidence.run_exports and nothing reads it back', 'get_export_status is the privacy data export, not runs; the Account dialog owns /[org]/account/export/[exportId]/route.ts, a pattern to copy'],
      issues: ['#2952'],
      task: `Add get_run_export (input exportId; output status with the stored vocabulary queued|building|ready|failed from evidence.run_exports and its check constraint in packages/database/src/schema/run-evidence-foundation.ts, bundleRef when ready, size, createdAt, error) with a handler over evidence.run_exports under withTenantDb, the API and MCP surfaces, a CLI "oxagen run export --status" line, and the capability doc. Add an app download route that streams the bundle from blob storage through @oxagen/storage for a ready export, in the shape of the account export route. On Run, after export_run, poll get_run_export (SSE if the run stream carries it, else a bounded poll) and turn the export id into a download link when ready, with the failed state and its error. Bind get_run_export with the action test as proof. Load oxagen-capability-contracts, oxagen-tenancy, and oxagen-four-store-data first.`,
      done: 'An exported run can be downloaded from the Run page once the job finishes; the status and the failure read back through the new capability on every surface; handler and action tests cover queued, building, ready, failed, and a foreign exportId (denied).',
    },
    {
      id: 'gateway', title: 'Gateway outcomes on the transcript; unmetered runs and the cache tile on Spend',
      owns: ['packages/oxagen/src/contracts/run.transcript.get.ts (gateway fields on the entry schema)', 'the get_run_transcript handler under packages/handlers/src and its test', 'docs/capabilities/run.transcript.get.md', 'apps/app/src/features/run/transcript*.tsx and transcript-model.ts (gateway entries)', 'apps/app/src/features/run/header.tsx (tier basis line)', 'apps/app/src/data/contracts/run.ts (transcript entry kinds block)', 'apps/app/src/data/live/mappers/runs.ts (same)', 'apps/app/src/features/spend/figures.tsx, spend.tsx (caveat and cache tile hunks) and tests', 'apps/app/src/data/contracts/spend.ts (unmetered count field)', 'apps/app/src/data/live/mappers/spend.ts', 'apps/app/messages/run.json and spend.json (own keys blocks)', 'packages/oxagen/src/contracts/spend.get.ts and its handler, only if the unmetered count is not already returned'],
      checks: ['the proxy seals llm_call frames, policy_decision refusals (session_budget_exceeded), and interrupt outcomes: packages/tacho/src/collector/model-proxy.ts, packages/handlers/src/tacho.events.ingest.ts ~584-592', 'the transcript model has policy and decision kinds (apps/app/src/data/contracts/run.ts ~176, 223-257)', 'get_run_transcript today projects only the derived label, decision, bodies, and cost; the handler drops the stored event body and attributes that carry policy_reason_code, oxagen.interrupted, the binding, and tier data, so the app cannot show them without a contract change', 'FleetSpend.cacheHitRate exists in data/contracts/spend.ts ~58-63 and Spend has no cache tile', '#3304: Codex and Stella runs report no usage; the DoD wants "N runs on harnesses that report no usage" beside every total'],
      issues: ['#3304', '#3299'],
      task: `(a) First extend get_run_transcript through the parity chain: optional fields on the transcript entry for policyReasonCode, interrupted, and binding (token or process), projected by the handler from the stored frame attributes the proxy writes (packages/tacho/src/collector/model-proxy.ts ~608 and ~864), and a run-level tierBasis derived only from the server-owned session fields tacho.sessions.enforcement_tier and gateway_observed_at. tacho.events.ingest.ts refuses to derive the tier from submitted attributes, and so must this read: a host can submit any attribute, so an oxagen.enforcement_tier attribute on a frame is a frame-level observation, never the basis of a trust word. With a handler test that proves a forged tier attribute does not change tierBasis, and the capability doc. Load oxagen-capability-contracts first. Then on the transcript, render a budget refusal (policy_decision with session_budget_exceeded), an interrupt outcome, and each model call's binding (token or process) and routed tier basis as their own entry kinds with the recorded reason, linked to the frame. On the header, beside the tier word, one line saying what computed it (routed through the gateway, or reported by the harness), from the server-owned session fields only, never from a frame attribute (ADR-095).
(b) On Spend, add the cache hit rate tile from the data get_spend already returns, and beside every total the caveat "N runs report no usage" when N > 0, linking to a filtered Fleet view. If get_spend does not return the count, add it to the contract output (optional field), the handler, and the doc, through the parity chain.
(c) Tests for each new transcript entry kind, the header basis line, the caveat at zero and at N, and the cache tile.`,
      done: 'A run that hit its session budget or was interrupted says so on the transcript with the frame; the tier word carries its basis; Spend names unmetered runs beside each total and shows the cache hit rate; tests cover all of it.',
    },
  ],
}

const result = await runSession(session, 'oxagen-roadmap:docs/mission-control-spec.md §14 Run and Spend rows, §8.5 proof, §7.1 the three seams, §12.6 token accounting; ADR-094, ADR-095, ADR-064; issues #2952, #2955, #3304, #3299')
return result
