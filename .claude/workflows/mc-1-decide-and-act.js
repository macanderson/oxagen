export const meta = {
  name: 'mc-1-decide-and-act',
  description: 'Rev1 app session 1: approve and deny with reason on Fleet and Run, the four-hop chain and eligibility on every card, the enforcement tier and verdict columns on Fleet, run controls from Fleet, and steer with a delivery mode; one PR',
  whenToUse: 'The P0 session. Run after mc-0-rebaseline. Owns issues #2950, #2953, #3285 and the app half of #2970 and #3286.',
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
  id: '1',
  title: 'Decide and act: approvals, trust columns, run controls',
  prTitle: 'Oxagen app: approve and deny from Fleet and Run, honest trust columns on Fleet, and run controls with a delivery mode',
  issueHint: 'Read #2950 and #2953 first. Use Closes #2950 only if every DoD box there is done (decision 1 recorded in the ADR, the dialog, the columns, the tests); otherwise Refs. Refs #2953, #3285, #2970, #3286.',
  lanes: [
    {
      id: 'approve', title: 'Approve and deny with a reason, the four-hop chain, and the eligibility line',
      owns: ['apps/app/src/features/fleet/approvals-panel.tsx and tests', 'apps/app/src/features/fleet/approval-decision*.tsx (new)', 'apps/app/src/features/fleet/actions.ts (new or existing)', 'apps/app/src/features/run/run.tsx (the approvals tab hunk only)', 'apps/app/src/data/live/mappers/approvals.ts', 'apps/app/src/data/contracts/approvals.ts', 'apps/app/src/data/live/approvals.ts', 'apps/app/messages/fleet.json (or the approvals namespace)', 'packages/oxagen/src/contracts/agent.approval.resolve.ts (layers)', 'apps/app/capability-ui-map.json (resolve_approval, get_auto_eligibility)', 'docs/adr/ADR-1xx-*.md (one new file)', 'docs/capabilities/agent.approval.resolve.md'],
      checks: ['no resolve_approval reference in apps/app/src outside kernel.test.ts', 'mappers/approvals.ts drops chain.rule and autoEligibility', 'run.tsx passes mandates={new Map()} to the Run approvals panel', 'data/live/approvals.ts PAGE_SIZE=100 counts one page for the waiting tile'],
      issues: ['#2950', '#2970', '#3286'],
      task: `(a) Read issue #2950 and record its decision 1 as an ADR: resolve_approval is the one billed governed action of the approvals surface (ADR-055 §1.5 names the model). Cite #2950 and the kernel seam.
(b) Add "app" to the layers of resolve_approval (packages/oxagen/src/contracts/agent.approval.resolve.ts; input approvalId, decision approved|denied, note). Write a server action resolveApprovalAction in the Fleet feature through the kernel seam (apps/app/src/server/kernel.ts, the kernelWrite path that server/kernel.test.ts already exercises for agentApprovalResolve).
(c) Build an approval decision dialog: approve or deny, a reason field (required for deny, optional for approve), the four-hop chain drawn as four links (who asked = requester, which agent = chain.agentKey or "not recorded", which action = tool, which rule = chain.rule with the mandate id when present), and the eligibility line from autoEligibility (rule id, ok, reasons, floor). Wire it into the pending card on the Fleet panel and the Run approvals tab (reuse the one panel; pass the run's mandates map on Run instead of an empty map). Every state: pending, submitting, denied (IAM), error with the kernel's message, resolved (card moves to the resolved list without a reload).
(d) Extend the mapper so chain.rule, mandateId, and autoEligibility reach the view model. Fix the waiting tile so it counts all pending approvals, not one page (a count field on the read, or paginate to the end with a cap and say "100+").
(e) Bind resolve_approval and get_auto_eligibility in capability-ui-map.json with the dialog's action test as proof. Update docs/capabilities/agent.approval.resolve.md Surfaces line.`,
      done: 'An approval can be approved or denied with a reason from Fleet and from the Run approvals tab; the card shows four hops and the eligibility line; the assistant flyout\'s "approve on Fleet" pointer is now true; tests cover approve, deny without reason (blocked), IAM denied, and kernel error.',
    },
    {
      id: 'columns', title: 'Enforcement tier and verdict columns on Fleet; no controls on observe-tier runs',
      owns: ['apps/app/src/features/fleet/runs-table.tsx and tests', 'apps/app/src/features/fleet/fleet.builders.ts', 'apps/app/src/data/contracts/runs.ts (verdict field)', 'apps/app/src/data/live/mappers/runs.ts', 'apps/app/src/features/run/run-controls.tsx (observe-tier hunk only, #3285)', 'apps/app/messages/fleet.json (own keys block)'],
      checks: ['runs-table.tsx has no Tier or Verdict column', 'RunRow carries enforcementTier but no verdict', 'list_runs returns verdict (packages/oxagen/src/contracts/run.list.ts ~181) and the app mapper drops it', 'run-controls.tsx offers controls on observe-tier runs (#3285)'],
      issues: ['#2950', '#3285', '#3295'],
      task: `(a) Add an Enforcement tier column to the Fleet runs table using RunRow.enforcementTier, rendered with the same tier badge component Run's header uses (apps/app/src/features/run/header.tsx ~196-201; promote the badge to apps/app/src/ui if it is local to Run). The words are the recorded tier and nothing stronger (ADR-095): gateway, harness, observe. Add a legend line under the table.
(b) Carry list_runs.verdict into RunRow and add a Verdict column that renders the recorded verdict or the NotRecorded inline state; never a placeholder.
(c) #3285: on observe-tier runs, hide pause, resume, cancel, and steer, and show the recorded reason line the run-controls already carry for ledger runs, adapted for observe. Do the same on any Fleet row control lane 'controls' adds (coordinate by reading its branch; if absent, leave a documented hook).
(d) Read issue #3304: beside the Fleet cost total, when runs on harnesses that report no usage exist in the window, render the caveat "N runs report no usage" with a link to the Spend page.`,
      done: 'Fleet shows Tier and Verdict for every row from recorded values; observe-tier runs offer no controls; the cost caveat renders when applicable; table tests cover each tier word, a null verdict, and the caveat.',
    },
    {
      id: 'controls', title: 'Pause, resume, cancel from Fleet rows, and steer with a delivery mode on Run',
      owns: ['apps/app/src/features/fleet/run-row-controls*.tsx (new) and tests', 'apps/app/src/features/fleet/actions.ts (dispatch hunk in its own block)', 'apps/app/src/features/run/run-controls.tsx (steer hunk only)', 'apps/app/src/features/run/actions.ts (steer payload hunk)', 'apps/app/messages/fleet.json and run.json (own keys blocks)', 'apps/app/capability-ui-map.json (dispatch_command: an also entry for Fleet)', 'tools/scripts/check_ui_parity.mjs and its test only if also support is absent on main'],
      checks: ['Fleet runs-table.tsx has no row controls', 'features/run/actions.ts ~74-78 sends no requestedMode for steer', 'dispatch_command input: target {kind run|agent|workspace, id}, command pause|resume|cancel|steer|message, payload {text, requestedMode} for steer and message, reason, expiresInMs'],
      issues: ['#2953', '#3286'],
      task: `(a) Add row controls to Fleet for live tacho runs: pause, resume, cancel, through dispatch_command with target.kind "run". Reuse the Run page's run-controls semantics and its disabled reasons (ledger runs: the recorded copy; observe runs: no controls). Confirm with the same dialog Run uses. Optimistic status update with rollback on error.
(b) On Run, add a delivery mode picker to steer: the modes dispatch_command's payload.requestedMode accepts (read the contract enum), default next_step, with one line per mode saying when the agent sees it. Send requestedMode with the steer.
(c) Bind dispatch_command on Fleet as an also entry in capability-ui-map.json with the row-controls test as proof, keeping the Run binding and its proof. The map holds one object per capability and the checker reads only bindings[name].page and .proof, so a second page is written as an also array entry ({route, page, proof}) that session 0's parity lane taught check_ui_parity.mjs to validate like the primary. If also is not yet supported on the main you branch from, add that support in this lane (checker, its test, and the $binding_shape doc) rather than duplicating the key or inventing a shape.`,
      done: 'A live wrapped run can be paused, resumed, and cancelled from Fleet; steer on Run carries a delivery mode; tests cover each command, the ledger and observe disabled states, and a kernel error.',
    },
  ],
}

const result = await runSession(session, 'oxagen-roadmap:docs/mission-control-spec.md §14 Fleet, Run and Approvals rows, §7.4 halting and commands, §7.5 human approval; issues #2950, #2953, #3285; ADR-095 for the tier words; ADR-070 for auto-approval eligibility')
return result
