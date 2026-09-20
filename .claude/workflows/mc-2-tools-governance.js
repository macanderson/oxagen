export const meta = {
  name: 'mc-2-tools-governance',
  description: 'Rev1 app session 2: the Tools page gains auto-approval rules, grant a mandate, a connections table with add connection, and servers in the registry, all over handlers that already ship; one PR',
  whenToUse: 'Run after mc-0-rebaseline; independent of session 1. Owns the app half of #2970 and the remainder of #2957.',
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
  id: '2',
  title: 'Tools governance: rules, grants, connections, servers',
  prTitle: 'Oxagen app: auto-approval rules, grant a mandate, connections, and servers on the Tools page',
  issueHint: 'Read #2970 and #2957. Their DoDs include backend and decision items; use Refs unless every box is done. Label closes-nothing if neither is closed.',
  lanes: [
    {
      id: 'rules', title: 'Auto-approvals tab: list, create, edit, enable, delete rules; eligibility explained',
      owns: ['packages/oxagen/src/contracts/approval_rule.set.ts and approval_rule.list.ts (expectedDigest in, digest out)', 'the set and list handlers under packages/handlers/src and their tests', 'apps/api and apps/mcp files for set_approval_rules and list_approval_rules if their shape changes', 'docs/capabilities/approval_rule.set.md and approval_rule.list.md', 'apps/app/src/features/tools/view.ts (add the tab)', 'apps/app/src/features/tools/rules*.tsx (new) and tests', 'apps/app/src/features/tools/actions.ts (rules block)', 'apps/app/src/data/contracts/tools.ts (rules view model block)', 'apps/app/src/data/live/tools.ts and mappers (rules block)', 'apps/app/src/data/ports.ts (rules read)', 'apps/app/messages/tools.json (rules keys block)', 'packages/oxagen/src/contracts/approval_rule.*.ts and approval.auto_eligibility.get.ts (layers only)', 'apps/app/capability-ui-map.json (five entries)'],
      checks: ['TOOLS_TABS in view.ts has registry, connections, switches, mandates only', 'no apps/app reference to list_approval_rules, set_approval_rules, delete_approval_rule, set_approval_rule_enabled, get_auto_eligibility', 'set_approval_rules replaces the whole list (rules[] up to 256; each: id, name, tools[] 1..64, enabled, maxMeasures, allowTargets, standingWindowMs, businessHours|null, createdBy, createdAt); ids unique', 'the input has no revision or digest, and the handler takes its lock after any client read, so two administrators editing at once can silently overwrite each other'],
      issues: ['#2970'],
      task: `(a) Add an "auto-approvals" tab to TOOLS_TABS. List rules from list_approval_rules with name, tools it matches, the limits it grants (maxMeasures, allowTargets), standing window, business hours, enabled, created by and when.
(b) Create and edit through set_approval_rules. The write replaces the whole list and the contract carries no revision, so first add optimistic concurrency on the contract: list_approval_rules returns a digest of the stored set (RFC-8785 canonical JSON of the rules, sha256; @oxagen/run-evidence has the canonicalizer), and set_approval_rules accepts an optional expectedDigest that the handler checks while it holds its lock, refusing with a typed error (code approval_rules_stale) when the stored digest differs. Ride the parity chain: contract, handler and its test, API and MCP if the shape changes, both capability docs. Then the action reads the list and its digest, applies the one change, writes back with expectedDigest, and on approval_rules_stale reloads and asks the operator to reapply. Enable and disable through set_approval_rule_enabled. Delete through delete_approval_rule with a confirm that names the rule.
(c) An "explain eligibility" affordance on a rule opens get_auto_eligibility for a chosen pending approval id and shows ok, reasons, and floor. Read ADR-070 for the words.
(d) Add "app" to the five contracts' layers and bind each in capability-ui-map.json with the tab's component and action tests as proof. Every UI state.`,
      done: 'Rules can be listed, created, edited, enabled, disabled, and deleted from Tools; eligibility can be explained; five bindings with real proofs; tests cover the replace-list write with expectedDigest, the handler refusing a stale digest under its lock, the action reloading on approval_rules_stale, and IAM denied.',
    },
    {
      id: 'grant', title: 'Grant a mandate from the Tools ledger and the agent Mandates tab; ledger links to the mandate page',
      owns: ['apps/app/src/features/tools/mandates-ledger.tsx and tests', 'apps/app/src/features/tools/grant-mandate*.tsx (new)', 'apps/app/src/features/tools/actions.ts (grant block)', 'apps/app/src/features/agents/mandates.tsx (entry point hunk only)', 'apps/app/e2e/routes.ts (mandate page row)', 'apps/app/messages/tools.json (grant keys block)', 'packages/oxagen/src/contracts/mandate.grant.ts (layers only)', 'apps/app/capability-ui-map.json (grant_mandate)', 'apps/app/ARCHITECTURE.md §1.2 Tools row (one sentence)'],
      checks: ['grant_mandate has no app layer, no binding, and no apps/app reference beyond a comment in agents/mandates.tsx', 'mandates-ledger.tsx has no link to /[org]/[ws]/mandates/[mandate]', 'apps/app/e2e/routes.ts has no mandate page row', 'grant_mandate input = mandateGrantInputSchema (packages/oxagen/src/mandates/schemas.ts ~312): agentId, consequenceTags, limits, targets, tools[], approval {humanAbove, alwaysHumanFor, approvers}, purpose, validFrom, validTo, requestId?; requiresApproval true; Owner and Admin'],
      issues: ['#2957'],
      task: `(a) Build a Grant a mandate dialog over grant_mandate: agent picker (list_agents), consequence tags, tool patterns, limits with their measure kind (ADR-108), targets, approval settings, purpose, validity window. When opened from a pending request on the agent Mandates tab, prefill from the request and pass requestId. The write requires approval on the contract; show the returned approval state honestly (granted, or parked for approval with the approval id and a link to Fleet).
(b) Put the entry point on the Tools mandates ledger and on the agent Mandates tab (the one place the request lives). Owner and Admin see it; others see the denied state on attempt, not a hidden button (read the existing role gating pattern in features/tools/switch-controls.tsx).
(c) Link every ledger row to /[org]/[ws]/mandates/[mandate] through routes.mandate (apps/app/src/ui/navigation.ts). Fix the stale "has no tab bar" comment in mandates-ledger.tsx.
(d) Add the mandate page to apps/app/e2e/routes.ts (title pages.mandate, a granted mandate's public id from the seed; read how runs/[run] is seeded there). Add "app" to grant_mandate's layers and bind it with the dialog's action test as proof. Amend ARCHITECTURE.md §1.2 Tools row with one sentence.`,
      done: 'A mandate can be granted from Tools and from a pending request on the agent page; every ledger row opens the mandate page; page-load walks the mandate route; tests cover grant, prefill from request, parked-for-approval, and IAM denied.',
    },
    {
      id: 'connections', title: 'Connections table with add connection; servers in the registry with import server',
      owns: ['apps/app/src/features/tools/connections.tsx and tests', 'apps/app/src/features/tools/add-connection*.tsx (new)', 'apps/app/src/features/tools/registry.tsx (servers section hunk)', 'apps/app/src/features/tools/register-server*.tsx (new)', 'apps/app/src/features/tools/actions.ts (connections and servers blocks)', 'apps/app/src/data/contracts/tools.ts (connections and servers blocks)', 'apps/app/src/data/live/tools.ts and mappers (same)', 'apps/app/src/data/ports.ts (two reads)', 'apps/app/messages/tools.json (own keys blocks)', 'packages/oxagen/src/contracts/connection.{list,get,create}.ts and agent.mcp.{list,register}.ts (layers only)', 'apps/app/capability-ui-map.json (five entries)'],
      checks: ['connections.tsx header comment says no capability lists connections; false: list_connections, get_connection, create_connection are registered', 'import-controls.tsx takes a server id the operator must already know; list_mcp_servers and register_mcp_server are registered and unbound', 'list_connections output has displayName and status but no owner or review date'],
      issues: [],
      task: `(a) Make the Connections tab a real connections table over list_connections (name, connector, status with the recorded status word, created) with a detail drawer over get_connection, keeping the credential grants log beneath it as a second section. Add connection over create_connection: connector id, display name, connection config, auth credential entered once and never echoed back, delivery method. Owner and review date are not on the contract: render nothing for them and file the contract field as a residue item in the PR body, not a fake column.
(b) In the registry, add a Servers section over list_mcp_servers (name, transport, endpoint, auth strategy, enabled) with Register a server over register_mcp_server, and make the import dialog pick a server from that list instead of a typed id.
(c) Add "app" to the five contracts' layers and bind each with the tests as proof. Every UI state.`,
      done: 'Connections are listed and can be added; servers are listed, registered, and picked for import; five bindings with real proofs; tests cover add connection, register server, import from a picked server, and IAM denied.',
    },
  ],
}

const result = await runSession(session, 'docs/specs/mission-control/spec.md §14 Tools row, §6.4 tool RBAC, §6.8 credential broker, §6.9 approval rules and mandates, §6.11 kill switches; issues #2970 and #2957; ADR-059, ADR-070, ADR-102, ADR-108')
return result
