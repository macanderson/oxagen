export const meta = {
  name: 'mc-0-rebaseline',
  description: 'Rev1 app session 0: re-baseline the gap record, record the 2026-09-14 cuts in an ADR, close the parity integrity holes, and bring the two open rev1 app PRs to green; one PR',
  whenToUse: 'Run first. It unblocks sessions 1 to 5 and rewrites docs/mission-control/GAP-INVENTORY.md against head.',
  phases: [
    { title: 'Scout', detail: 'confirm each lane is still open on main' },
    { title: 'Build', detail: 'three lanes in parallel worktrees' },
    { title: 'Integrate', detail: 'merge lanes, open the PR, drive CI green' },
    { title: 'Review', detail: 'cold review; fix P0 and P1; residue issue for the rest' },
  ],
}

// ---------------------------------------------------------------------------
// Shared preamble. Every mc-* workflow carries an identical copy because a
// workflow script cannot import another file. Edit docs/mission-control/
// BUILD-CHUNKS.md §"Workflow shape" when you change it, and change every copy.
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
CONTEXT you must read before editing (paths relative to the repo root):
- docs/mission-control/BUILD-CHUNKS.md: the session plan and the corrected gap facts. Your session's section names your lane and what is already built.
- docs/audits/2026-09-19-mission-control-gap-inventory-review.md: why the older gap inventory is stale. Do not rebuild anything §1 there marks Built.
- apps/app/ARCHITECTURE.md §1.2 (the page set and what each page reads), §3 (viewer, kernel, ports, mappers, SSE, not recorded), §4 (invariants), §6 (testing).
- docs/specs/mission-control/spec.md §14 (the page table), and the section your lane names.
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
3. Read the combined diff once, end to end, against docs/mission-control/BUILD-CHUNKS.md §${session.id} and the spec sections it names. Fix anything missing or inconsistent. Run the generators whose --check would fail (gen:messages, docs:schemas) and commit their output. Update apps/app/e2e/routes.ts for any new route.
4. Update apps/app/ARCHITECTURE.md §1.2 rows the session changes, and tick the session's "Done when" boxes in docs/mission-control/BUILD-CHUNKS.md that are now true. Commit and push.
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
    if (!validLane(result) || !active.some(l => l.id === result.lane)
      || reported.filter(other => other.lane === result.lane).length !== 1) {
      log('invalid or duplicate lane result; stopping before integration')
      return { session: session.id, scout, error: 'invalid lane result', reported }
    }
    const remote = await agent(
      `Read-only verification. Run git ls-remote --heads origin refs/heads/${result.branch} in the repository. Return exists=false if absent or the command fails; otherwise return the exact remote branch and 40-character head SHA. Do not edit files or push.`,
      { label: `verify:${result.lane}`, phase: 'Build', schema: REMOTE_HEAD, agentType: 'general-purpose' },
    )
    if (!remote || !remote.exists || remote.branch !== result.branch || remote.head_sha !== result.head_sha) {
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
  id: '0',
  title: 'Re-baseline the gap record and the parity gate',
  prTitle: 'Oxagen app: re-baseline the gap inventory at head, record the 2026-09-14 cuts, and make the parity gate check its proofs',
  issueHint: 'This PR closes no issue by design: label closes-nothing. Refs #2592, #2950, #2957, #3286 where the docs cite them.',
  lanes: [
    {
      id: 'docs', title: 'Gap record, cut ADR, spec and architecture corrections, missing capability docs',
      owns: ['docs/mission-control/GAP-INVENTORY.md', 'docs/adr/ADR-1xx-*.md (one new file)', 'docs/specs/mission-control/spec.md §2.1 and §14 (notes only)', 'apps/app/ARCHITECTURE.md §1.2 lines for Skills and Mandate', 'docs/capabilities/*.md (twelve new files)', 'docs/capabilities/_index.md'],
      checks: ['GAP-INVENTORY.md still says Mandate detail Missing', 'ARCHITECTURE.md §1.2 still claims a skills/[[...tab]] catch-all', 'no ADR records the 2026-09-14 scope review', 'docs/capabilities lacks files for approval_rule.{list,set,delete,enabled.set}, approval.auto_eligibility.get, mandate.{grant,revoke,limits.update,request,list,get}, context.steering.freshness'],
      issues: ['#2957', '#3286', '#2592'],
      task: `(a) Rewrite docs/mission-control/GAP-INVENTORY.md against origin/main: apply every correction in docs/audits/2026-09-19-mission-control-gap-inventory-review.md §1 to §3 and §5, keep the page-by-page table shape, add a "Class" column (UI-only, UI plus backend, backend, cut) per row, take the page set from apps/app/src/app with ARCHITECTURE.md §1.2 as the map, drop the scorecard, and name the owning issue per row. Keep the "Cut" rows and cite apps/app/ARCHITECTURE.md §9 (2026-09-14, 2026-09-15, 2026-09-18 entries) and ADR-062 for each.
(b) Write one ADR, next free number after the highest in docs/adr, titled "The 2026-09-14 scope review: what the rev1 app does not build", recording the ten cuts and the two reversals (Audit page 2026-09-15 #3097, Model funding 2026-09-18) with their ARCHITECTURE.md §9 sources. Status Accepted, decided by the maintainer on the dates given. Follow the shape of docs/adr/ADR-095.
(c) In docs/specs/mission-control/spec.md add a one-line status note under §2.1 that legal hold, reconciliation, and the ontology engine are cut for rev1 per that ADR. Do not rewrite the spec.
(d) In apps/app/ARCHITECTURE.md §1.2 correct the Skills row (no catch-all route exists; the page is one section; Phase 2 moves it under Steering per ADR-097) and the Mandate row's "not yet built" sentence (line ~90), and add a decision-log line dated today.
(e) Write the twelve missing docs/capabilities/<stem>.md files (stem = the contract file's dotted stem) in the shape of an existing one such as docs/capabilities/kill_switch.set.md, with the Surfaces line matching each contract, and add them to docs/capabilities/_index.md. Run pnpm docs:schemas if it owns any of them and commit its output.`,
      done: 'GAP-INVENTORY.md has no row the review refutes; the ADR exists and is linked from ARCHITECTURE.md §9 and the inventory; pnpm check:contracts passes on the docs (it is a lightweight check and allowed); the twelve doc files exist and the index lists them.',
    },
    {
      id: 'parity', title: 'The parity gate verifies proof paths; two binding defects fixed',
      owns: ['tools/scripts/check_ui_parity.mjs', 'tools/scripts/check_ui_parity.test.* (or its existing test file)', 'apps/app/capability-ui-map.json (two entries)', 'apps/app/src/features/billing/contract-rate.test.tsx (new)', 'packages/oxagen/src/contracts/context.steering.freshness.ts (layers only)', 'apps/app/src/features/steering/freshness.test.tsx (if missing)'],
      checks: ['check_ui_parity.mjs line ~236 only tests that proof is non-empty', 'ui-map get_contract_rate.proof names apps/app/src/features/billing/contract-rate.test.tsx which does not exist', 'get_steering_freshness declares no app layer and has no binding though apps/app/src/features/steering/freshness.tsx invokes it'],
      issues: [],
      task: `(a) Make tools/scripts/check_ui_parity.mjs fail, under --strict, when a binding's proof path does not exist on disk. No exception: verifiedAt and verifiedBy are self-reported metadata, not evidence, and verifications/ is gitignored, so a proof must be a tracked apps/app component or action test that exists (no binding names an image today; count them first and say so in the PR). Update the $binding_shape doc in capability-ui-map.json to say exactly that. Also teach the checker an optional also array on a binding ({route, page, proof} per entry, validated like the primary) so one capability can be bound on two pages without a duplicate key, and document it in $binding_shape. Add tests beside the script's existing tests for the dangling proof, the image proof, and an also entry with a missing page. Keep the baseline mechanism untouched.
(b) Write apps/app/src/features/billing/contract-rate.test.tsx: a component test that renders the contracted-rate figure from a fixture through the same component the Billing page uses (read features/billing/summary.tsx or this-month.tsx to find it). Then the existing ui-map proof is real.
(c) Add "app" to the layers of get_steering_freshness in packages/oxagen/src/contracts/context.steering.freshness.ts and bind it in capability-ui-map.json to /[org]/[ws]/steering with the freshness panel's test as proof (write features/steering/freshness.test.tsx if none exists). Run the script locally with node tools/scripts/check_ui_parity.mjs --strict; that single script is a lightweight check and allowed.`,
      done: 'node tools/scripts/check_ui_parity.mjs --strict passes, fails on a dangling or untracked proof, and validates also entries (the new tests prove all three); both bindings have real proofs.',
    },
    {
      id: 'prs', integrate: false, title: 'Bring the two open rev1 app PRs to green and report merge readiness (sidecar: never merged into this session)',
      owns: ['the branches of PR #3479 (mc/creation-wizards) and PR #3459 (mc/repositories-page) only'],
      checks: ['PR #3479 state and CI', 'PR #3459 state and CI', 'whether either has merged already'],
      issues: [],
      task: `For each of PR #3479 and PR #3459 on macanderson/oxagen, if still open: check out its branch in a worktree, merge origin/main into it (git merge, never rebase), resolve conflicts, push, watch CI, fix failures and push up to four rounds. Address every open review thread whose ask is small; reply with a proposal for larger ones. Read the Claude Approvals check if the repo runs it and work its rows. Do NOT merge either PR. Report for each: head sha, ci_state, mergeable state, open threads, and whether a maintainer can merge it now. If a PR has merged, say so and skip it.`,
      done: 'Both PRs are green and mergeable, or the report names exactly what blocks each.',
    },
  ],
}

const result = await runSession(session, 'docs/audits/2026-09-19-mission-control-gap-inventory-review.md §5, ADR-095 as the ADR shape, tools/scripts/check_ui_parity.mjs, docs/capabilities/kill_switch.set.md as the doc shape')
return result
