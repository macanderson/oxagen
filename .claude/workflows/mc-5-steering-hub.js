export const meta = {
  name: 'mc-5-steering-hub',
  description: 'Rev1 app session 5: the Steering hub as path segments with the Memory and Policy tabs and a single-record route, the UI-only half of Phase 2 over handlers that ship today; Preview, skill sync, and ontology notes wait on Phases 1 and 2; one PR',
  whenToUse: 'Run only after PR #3479 (creation wizards, Skills as a tab of Steering) and session 2 (the Tools auto-approvals editor the Policy tab links to) have merged. Advances #3297 and #3395. Do not add governance ceremony: ADR-091 §6 freeze.',
  phases: [
    { title: 'Scout', detail: 'confirm #3479 merged and each lane is still open' },
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
  id: '5',
  title: 'Steering hub: segments, Memory, Policy, one record',
  prTitle: 'Oxagen app: Steering tabs as path segments, the Memory and Policy tabs, and a route for one published record',
  issueHint: 'Refs #3297 and #3395; Closes #3395 only if its DoD is fully done. The freeze in ADR-091 §6 forbids new proposal states, checks, or review steps; add none.',
  lanes: [
    {
      id: 'segments', title: 'Steering tabs as path segments; one route per published record',
      owns: ['apps/app/src/app/[org]/[ws]/steering/[[...tab]]/page.tsx (new; it replaces steering/page.tsx, which is deleted, because Next.js 16 refuses an optional catch-all beside a page of the same specificity)', 'apps/app/src/app/[org]/[ws]/steering/records/[record]/page.tsx (new)', 'apps/app/src/features/steering/view.ts, tabs.tsx, steering.tsx (tab routing hunks)', 'apps/app/src/features/steering/record*.tsx (new) and tests', 'apps/app/src/ui/navigation.ts (routes.steering(tab), routes.record)',  'apps/app/e2e/routes.ts (new rows)', 'apps/app/messages/steering.json (own keys block)', 'apps/app/capability-ui-map.json (get_record)'],
      checks: ['steering tabs are ?tab= query values (features/steering/view.ts ~3-5), spec §10.7 wants /{org}/{ws}/steering/{tab} with records default, /steering/skills/{view}, /steering/proposals/prs', 'no route renders a single published record (#3395); get_record is registered', 'PR #3479 added the skills tab and the /skills redirect; verify what merged'],
      issues: ['#3297', '#3395'],
      task: `(a) Move the Steering tabs to path segments per spec §10.7 with records as the default. One route owns them all: create steering/[[...tab]]/page.tsx and delete steering/page.tsx, moving its content, metadata, and tests into the catch-all; the route sorter throws on a page beside an optional catch-all. Keep keeping the tab order Records, Skills, Memory, Ontology, Policy, Proposals, Preview and rendering the NotBacked state for Ontology and Preview (Phase 1 and 2, #3296, #3297) as one line each, never an empty tab. Redirect the old ?tab= values (records, proposals, prs, and skills if #3479 added it) inside the catch-all page, which receives searchParams; legacy-routes.ts cannot do it because proxy.ts hands it only the pathname. Cover each old value in the page test. Skills views at /steering/skills/{view} and open Context PRs at /steering/proposals/prs.
(b) A page for one published record at /steering/records/{record} over get_record: kind, force, statement, lineage, validity, the pull request that published it, and its hash as a copyable identifier. Link every record card to it.
(c) e2e/routes.ts rows for the default tab and the record page. Bind get_record with the page's test as proof.`,
      done: 'Every tab has a path through one optional catch-all and steering/page.tsx is gone; /steering renders Records; a published record has its own page; page-load walks both; tests cover tab routing and the record page.',
    },
    {
      id: 'memory', title: 'Memory tab: what agents remembered, with provenance; read and retire',
      owns: ['packages/oxagen/src/contracts/agent.memory.model.ts and agent.memory.list.ts (optional provenance fields)', 'the list_memories handler under packages/agent/src/handlers and its test', 'docs/capabilities/agent.memory.list.md', 'apps/app/src/features/steering/memory*.tsx (new) and tests', 'apps/app/src/features/steering/actions.ts (memory block)', 'apps/app/src/data/contracts/steering.ts (memory block)', 'apps/app/src/data/live/steering.ts and mappers (memory block)', 'apps/app/src/data/ports.ts (memory read)', 'apps/app/messages/steering.json (memory keys block)', 'packages/oxagen/src/contracts/agent.memory.{list,delete,demote}.ts (layers only)', 'apps/app/capability-ui-map.json (list_memories, delete_memory, demote_memory)'],
      checks: ['list_memories, delete_memory, demote_memory are registered from packages/agent/src/handlers/index.ts and unbound', 'spec §10.7 Memory: what agents remembered (:AgentMemory), provenance to the frame that taught it, read and retire; a memory becomes a rule only by being proposed as a record', 'the memory record (agentMemoryRecordSchema in agent.memory.model.ts) carries source as a free-form string and citationCount, and no run id or frame id, so a frame link cannot be drawn from today\'s read'],
      issues: ['#3297'],
      task: `First settle provenance on the contract. Read where memories are written (the save_memory and recall paths under packages/agent and the store under packages/database/src/schema/agent.ts) and whether a run id or frame seq is stored or derivable from source. If it is, add optional provenance fields to agentMemoryRecordSchema (runId, frameSeq) populated by the list handler, through the parity chain with the handler test and the capability doc. If it is not, do not invent them: render source as recorded and the NotRecorded inline state where the frame link would go, and put the store change in the PR body as residue. Then build the Memory tab over list_memories: each memory with its agent, its provenance (the frame link when recorded, else source as recorded), citations, and age. Retire through delete_memory (confirm) and demote through demote_memory. "Propose as a record" hands the memory's text to the existing propose_record flow (the wizard from #3479 if merged, else the proposals action); add no new state. Add "app" to the three contracts' layers and bind them with the tab's tests as proof. Every UI state.`,
      done: 'Memories are listed with provenance as recorded (a frame link only when the contract carries it), can be retired or demoted, and can be proposed as a record through the existing flow; three bindings with real proofs; tests cover each write and IAM denied.',
    },
    {
      id: 'policy', title: 'Policy tab: mandates, approval rules, and kill switches in one view with their owning pages',
      owns: ['packages/oxagen/src/contracts for list_mandates and list_kill_switches pagination', 'their handlers and co-located tests', 'API, MCP and CLI adapters and capability docs for changed contracts', 'apps/app/src/data/contracts and ports (policy pagination blocks)', 'apps/app/src/features/steering/policy*.tsx (new) and tests', 'apps/app/src/data/live/steering.ts (policy reads, composing existing ports)', 'apps/app/messages/steering.json (policy keys block)', 'apps/app/capability-ui-map.json (also entries on list_mandates, list_approval_rules, list_kill_switches for the Steering page)', 'tools/scripts/check_ui_parity.mjs and its test only if also support is absent on main'],
      checks: ['list_mandates, list_approval_rules, list_kill_switches are registered; the first and third are bound to Tools', 'gate notices (ADR-097 §3) are compiled in Phase 1 and do not exist'],
      issues: ['#3297'],
      task: `First remove silent list truncation: list_mandates caps at 100 and list_kill_switches at 200. Add backward-compatible cursor pagination with deterministic ordering and tenant-scoped cursors through contracts, handlers and the parity chain, then make the policy reader consume every page. Test more than 100 mandates and 200 switches, later-page active rows, tenant isolation and later-page errors. A failed page must show an error, never a complete-looking partial list. Build the Policy tab as a read view of the gates that steer: active mandates, enabled approval rules, and kill switches that are on, each row linking to the page that edits it (the mandate page, Tools › auto-approvals, Tools › switches). For the one-line gate notice each gate will emit into steering (ADR-097 §3), render the NotBacked line naming Phase 1, not an invented sentence. Add an also entry on each of the three capabilities for the Steering page with the tab's test as proof, keeping their Tools and Agents bindings. The map holds one object per capability and the checker reads only bindings[name].page and .proof, so a second page is written as an also array entry ({route, page, proof}) that session 0's parity lane taught check_ui_parity.mjs to validate like the primary. If also is not yet supported on the main you branch from, add that support in this lane (checker, its test, and the $binding_shape doc) rather than duplicating the key or inventing a shape.`,
      done: 'The Policy tab lists every active gate with a link to its editor and says honestly that gate notices arrive with Phase 1; tests cover the three lists and the empty state.',
    },
  ],
}

const result = await runSession(session, 'docs/specs/mission-control/spec.md §10.7 Steering is the hub, §14 Steering row, §9 context records; ADR-091 §6 (the freeze), ADR-093, ADR-097; issues #3297, #3395, #3296')
return result
