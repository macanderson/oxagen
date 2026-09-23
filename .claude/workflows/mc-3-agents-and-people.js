export const meta = {
  name: 'mc-3-agents-and-people',
  description: 'Rev1 app session 3: agent roles assigned from the page, enrollment revoked and minted from the page, toolbelt input schemas carried on the contract, budgets read on the agent, and invitations sent from Organization; one PR',
  whenToUse: 'Run after mc-0-rebaseline; independent of sessions 1 and 2. Advances #2956 and #2964.',
  phases: [
    { title: 'Scout', detail: 'confirm each lane is still open on main' },
    { title: 'Build', detail: 'four lanes in parallel worktrees' },
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
- docs/audits/2026-09-19-mission-control-gap-inventory-review.md: why the older gap inventory is stale. Do not rebuild anything §1 there marks Built.
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
  id: '3',
  title: 'Agents and people: roles, enrollment, schemas, budgets, invitations',
  prTitle: 'Oxagen app: roles and enrollment as writes on the agent page, toolbelt schemas, budgets on the agent, and send an invitation',
  issueHint: 'Read #2956 and #2964; use Refs unless a DoD is fully done. Label closes-nothing otherwise.',
  lanes: [
    {
      id: 'roles', title: 'Assign and revoke an agent role from the identity tab',
      owns: ['apps/app/src/features/agents/identity.tsx and tests', 'apps/app/src/features/agents/role-controls*.tsx (new)', 'apps/app/src/features/agents/actions.ts (roles block)', 'apps/app/messages/agents.json (roles keys block)', 'packages/oxagen/src/contracts/agent.role.{assign,revoke}.ts (layers only; find them by name)', 'apps/app/capability-ui-map.json (assign_agent_role, revoke_agent_role)'],
      checks: ['identity.tsx renders a read-only roles table', 'assign_agent_role and revoke_agent_role are registered from packages/agent/src/handlers/index.ts and unbound'],
      issues: ['#2956'],
      task: `Add assign (role picker from list_iam_roles, scope) and revoke on each role row of the identity tab through assign_agent_role and revoke_agent_role via the kernel seam. Confirm revoke with the role name. Bind both with the component's action test as proof. Every UI state.`,
      done: 'A role can be assigned to and revoked from an agent on its page; tests cover both writes and IAM denied.',
    },
    {
      id: 'enrollment', title: 'Revoke an enrollment and mint an enrollment token from the enrollment tab; budgets read on the agent',
      owns: ['apps/app/src/features/agents/enrollment.tsx, host-row.tsx and tests', 'apps/app/src/features/agents/enrollment-controls*.tsx (new)', 'apps/app/src/features/agents/budget-panel*.tsx (new)', 'apps/app/src/features/agents/actions.ts (enrollment and budget blocks)', 'apps/app/src/data/contracts/agents.ts (budget view block)', 'apps/app/src/data/live/agents.ts (budget read)', 'apps/app/messages/agents.json (own keys blocks)', 'packages/oxagen/src/contracts/tacho.enrollment.revoke.ts (surfaces and layers)', 'apps/app/capability-ui-map.json (revoke_tacho_enrollment; an also entry for create_enrollment_token on the agent page)', 'tools/scripts/check_ui_parity.mjs and its test only if also support is absent on main'],
      checks: ['host-row.tsx has no actions; the empty state prints oxagen agent enroll', 'features/onboarding/actions.ts ~117 already mints a token through create_enrollment_token for the register flow', 'revoke_tacho_enrollment surfaces are ["api"] only', 'set_spend_budget scopes are org and workspace only; no agent-scope budget contract'],
      issues: ['#2956', '#2953'],
      task: `(a) Revoke a host enrollment from its row through revoke_tacho_enrollment (hostEnrollmentId, reason). Add "app" to its layers and "mcp" to its surfaces only if the parity checklist requires it for the app layer (read tools/scripts/check_manifest.mjs); otherwise app only. Confirm with the hostname.
(b) "Enroll a host" on the enrollment tab mints a token through create_enrollment_token the way the register flow does, shows the exact oxagen agent enroll command once with copy, and lists the token's expiry. Reuse the register flow's component if it is promotable. Bind create_enrollment_token on the agent page as an also entry, keeping its register binding. The map holds one object per capability and the checker reads only bindings[name].page and .proof, so a second page is written as an also array entry ({route, page, proof}) that session 0's parity lane taught check_ui_parity.mjs to validate like the primary. If also is not yet supported on the main you branch from, add that support in this lane (checker, its test, and the $binding_shape doc) rather than duplicating the key or inventing a shape.
(c) Budgets on the agent: a read-only panel that shows the workspace budget this agent runs under (get_spend_budget) with its basis and a link to Spend › Budgets. Agent-scope budgets have no live contract: render the NotBacked line naming that, and put the ADR question (agent-scope budgets in billing.budgets) in the PR body as residue. Do not build a fake set budget.`,
      done: 'An enrollment can be revoked and a new one minted from the agent page; the agent shows the budget it runs under with its basis; tests cover revoke, mint, and the NotBacked budget line.',
    },
    {
      id: 'schemas', title: 'Toolbelt carries each tool\'s input schema, rendered per tool',
      owns: ['packages/oxagen/src/contracts/agent.toolbelt.get.ts', 'packages/handlers/src/agent.toolbelt.get.ts (or the agent package handler; find by name)', 'its co-located test', 'apps/api and apps/mcp files for get_agent_toolbelt if their shape changes', 'docs/capabilities/agent.toolbelt.get.md', 'apps/app/src/features/agents/toolbelt.tsx and tests', 'apps/app/src/data/contracts/agents.ts (toolbelt block)', 'apps/app/src/data/live/mappers/agents.ts (toolbelt block)', 'apps/app/messages/agents.json (toolbelt keys block)'],
      checks: ['beltToolSchema in agent.toolbelt.get.ts (~30-45) has name, kind, server, category, riskLevel, decision, rule, readOnly and no schema field', 'tool versions carry schemas in the tools store (read packages/database/src/schema for tool_versions and the tool.version.list contract for schemaOrigin)'],
      issues: ['#2956'],
      task: `Add an optional inputSchema (JSON Schema object, capped at a size you choose and state, with a truncated flag) and schemaDigest to beltToolSchema, populated from the authority for each tool kind: a capability uses its registered contract.input converted to JSON Schema; an MCP tool uses the same discovered descriptor and server identity as materialization; a versioned tool uses its resolved immutable version. Do not join by an unqualified tool name. Cover all three kinds, same-name tools on different servers, and a missing descriptor in tests. Keep the output backward compatible (optional fields). Update the handler test, the capability doc, and run pnpm docs:schemas. In toolbelt.tsx render the schema per tool in a collapsible block with copy, beside the decision rule, and the digest as the copyable identifier. Load oxagen-capability-contracts first; this is a contract change and rides the whole parity chain.`,
      done: 'get_agent_toolbelt returns each tool\'s input schema and digest; the toolbelt shows them; the handler test and the component test cover a tool with and without a schema.',
    },
    {
      id: 'invite', title: 'Send an invitation from Organization › People',
      owns: ['apps/app/src/features/organization/people.tsx and tests', 'apps/app/src/features/organization/invite-dialog*.tsx (new)', 'apps/app/src/features/organization/actions.ts (invite block)', 'apps/app/messages/organization.json (invite keys block)', 'packages/oxagen/src/contracts/workspace.invite.send.ts (layers only)', 'apps/app/capability-ui-map.json (send_workspace_invite)'],
      checks: ['people.tsx renders a read-only invitations table and its header comment defers sending to the #2964 lane', 'send_workspace_invite is scoped:true (email, role member|admin|owner, message) but its handler inserts an organization invitation with orgId and an org role; list_members documents that workspace invitations do not exist, so a picked workspace is invocation scope only and is never recorded', 'a second invitation for a pending email returns the existing invitation, not an error'],
      issues: ['#2964'],
      task: `Add "Invite" on People: email, role, optional message. No workspace picker: the handler records an organization invitation with an org role and no workspace, so the copy says the invitation admits the person to the organization with that role, nothing more. The contract is scoped, so the action invokes it under the viewer's current workspace scope (the one the shell holds) purely as invocation scope, and the dialog never shows that workspace as a grant. The pending invitations table refreshes without a reload. A second invitation for an email that is already pending returns the existing invitation: show "already invited" from that result, not an error, and test that idempotent path. Add "app" to the contract's layers and bind it with the dialog's action test as proof. Every UI state.`,
      done: 'An organization invitation can be sent from People; the pending list shows it; tests cover send, the idempotent already-invited result, and IAM denied.',
    },
  ],
}

const result = await runSession(session, 'oxagen-roadmap:docs/mission-control-spec.md §14 Agents and Organization rows, §6.2 agent identity and credentials, §6.3 roles and grants, §6.6 the toolbelt; issues #2956, #2964, #2953; ADR-065, ADR-106')
return result
