export const meta = {
  name: 'mission-control-wizards-and-repositories',
  description: 'Build the skill/agent/context-record creation wizards and the Repositories page (Settings leaves the workspace menu) per the oxagen-roadmap spec; two PRs',
  phases: [
    { title: 'Shell + skill wizard' },
    { title: 'Agent + record wizards' },
    { title: 'Integrate wizards PR' },
    { title: 'Repositories page' },
    { title: 'Review' },
  ],
}

const RULES = `
HARD RULES (Mac's standing rules for this repo — restate them to any subagent you spawn):
- NO local verification of any kind: do not run tests (not even one file), Biome/pnpm format, tsc/typecheck, eslint/lint, builds, turbo, or pnpm dev. CI on the PR is the only gate. Write tests; let CI run them.
- NEVER run all tests. (You run none.)
- Never commit or push to main. Never git stash (the stash stack is shared across worktrees). Never rebase/squash shared history; use git merge.
- Worktrees live at ~/Projects/.worktrees/oxagen/<slug>, created from ~/Projects/oxagen. Local main is stale: always base on origin/main after 'git fetch origin'.
- Push immediately after creating a branch, commit and push small increments often.
- Load the clear-prose skill (.claude/skills/clear-prose) before writing UI strings, code comments, commit messages or PR bodies; oxagen-branding for customer-facing copy.
- Load oxagen-app-conventions, quality-gates and oxagen-testing before UI work; oxagen-capability-contracts + oxagen-surface-patterns if you add or touch a capability (parity rule: contract -> API route -> MCP tool -> CLI -> app UI, and apps/app/capability-ui-map.json binding with a component/action test as proof).
- Read DEREGISTERED.md before removing anything; de-registering is not deleting.
- Every UI state from quality-gates: loaded, empty, loading, error, denied, phone width. Every new component/action gets a co-located test.
- Unset CLICOLOR_FORCE and FORCE_COLOR before any gh --json call.
- Pre-push hooks run generators' --check modes. When they fail, run the generator and commit its output: 'pnpm --filter @oxagen/app gen:messages' (messages.d.ts) and 'pnpm docs:schemas' (docs/capabilities/schemas). Those are code generators, not verification, and are allowed. Also add a docs/capabilities/<stem>.md for every new contract. A WIP push may use --no-verify; the push before opening the PR must pass the hooks.
- Fix any defect you run into in the files you touch (fix over file), and name it in the PR body.
`

const SPEC = `
SOURCE OF TRUTH (build it EXACTLY as specified; where the roadmap mockup and the oxagen spec disagree, the roadmap mockup wins for UI and the oxagen spec wins for data/security):
- ~/Projects/oxagen-roadmap/docs/creation-spec.md (§1 one shape, entry points; §2 wizard shell; §4 skill; §5 context record; §6 never-do list). The agent wizard is described there too (wzAgent) and in mockups/pages/agents.md.
- ~/Projects/oxagen-roadmap/mockups/src/engine.js: DLG_EXT.create, DLG_EXT.wz, wzSteps, wzDescIn, wzSkill, wzAgent, wzRecord, pRecord, pSkillSource (the reference implementation — mirror its steps, copy, validation and states), rendered in mockups/missioncontrol.html; styles in mockups/src/engine.css.
- ~/Projects/oxagen-roadmap/mockups/pages/{agents,skills,steering,record,skill-source,steering-proposals}.md and any *.audit-prompt.md beside them.
- ~/Projects/oxagen-roadmap/docs/mission-control-spec.md §10 (context & steering, main repo, Context PRs, .oxagen/ layout), §14 (Mission Control pages).
- Core invariant: every wizard ends by opening a pull request against the workspace's main repo (the thing exists on merge). No wizard writes a row or has a Save-to-database button. The drafting turn is oxagen.assistant's, billed to Oxagen, never shown in Fleet/Spend, and every drafting step says the operator can change every line.
The app is apps/app (features under apps/app/src/features/*, routes under apps/app/src/app/[org]/[ws]/*, UI kit apps/app/src/ui/*, data contracts apps/app/src/data/contracts/*). Check what backend capabilities already exist (e.g. drafting, opening a Context PR via the GitHub App) under packages/oxagen/src/contracts and packages/handlers before adding any; reuse, and wire a missing one through the full parity chain.
`

const RESULT = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    worktree: { type: 'string' },
    pr_url: { type: 'string' },
    head_sha: { type: 'string' },
    ci_state: { type: 'string', description: 'green | red | pending | not-opened' },
    summary: { type: 'string' },
    spec_deviations: { type: 'array', items: { type: 'string' } },
    open_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'summary', 'ci_state', 'open_gaps'],
}

const SHELL_BRANCH = 'mc/creation-wizards'

async function wizardsTrack() {
  phase('Shell + skill wizard')
  const shell = await agent(`${RULES}\n${SPEC}
TASK: Build the shared creation-wizard shell and the SKILL wizard in apps/app.
1. RESUMING (third interruption). The worktree ~/Projects/.worktrees/oxagen/creation-wizards on ${SHELL_BRANCH} already has, pushed: propose_skill (ADR-090), the Create chooser in the command menu, apps/app/src/shared/create.ts, and commit 3a4b894c4 'creation-wizard shell, the skill wizard, and Skills as a tab of Steering', plus two untested-looking test files in apps/app/src/features/create (bundle.test.ts, skill-file.test.ts) committed as WIP. Do NOT recreate anything. Read git log origin/main..HEAD and the diff, audit it against the spec, finish what is missing, and commit+push within your first few minutes and after every step (sessions have been dying; unpushed work is lost). Steps 2-4 below describe the target; skip what is already done.
2. Build the wizard shell per creation-spec §2 (draft state, step list as a function of kind, the step rail with current step in gold and completed steps ticked, the description field that does not re-render on each keystroke, the final pull-request step), designed so the agent and context-record wizards plug in as new kinds with no shell changes. Build the Create chooser (⌘K "Create") and the entry-point table from §1 for the kinds being built (skill, agent, record) — leave the tool kind out of the chooser for now but keep the shell able to host it.
3. Build the skill wizard (creation-spec §4, wzSkill, pSkillSource) end to end, reachable from Steering · Skills "Add a skill". Skills is a tab of Steering per the spec; reconcile the existing apps/app/src/app/[org]/[ws]/skills route with that (redirect, do not delete the capability).
4. Tests for shell and skill wizard (component + action). Commit and push often. Do NOT open the PR yet — the integrator does.
5. Write a short note at ~/Projects/.worktrees/oxagen/creation-wizards/.wizard-shell-notes.md (gitignored is fine; else do not commit it) describing the shell's extension API so the agent and record wizard builders can plug in.
Return the branch, worktree, head sha, summary, any spec deviations and open gaps (ci_state: not-opened).`, { label: 'shell+skill', phase: 'Shell + skill wizard', schema: RESULT, agentType: 'general-purpose' })
  if (!shell) { log('shell agent failed; wizards track stopped'); return null }

  phase('Agent + record wizards')
  const kinds = [
    { slug: 'agent', branch: 'mc/wizard-agent', what: 'the AGENT wizard ("New agent" on Agent IAM / the Agents page; wzAgent; mockups/pages/agents.md). New agent writes .oxagen/agents/<slug>.toml per spec §6/§10 (identity in Postgres, definition in git); it is NOT Register an agent (which wraps an existing agent) — keep both distinct.' },
    { slug: 'record', branch: 'mc/wizard-record', what: 'the CONTEXT RECORD / STEERING RECORD wizard ("Write a context record" on every Steering tab except Skills; creation-spec §5; wzRecord, pRecord; mockups/pages/record.md, steering.md). The file is a TOML record, schema = "context-record/v0.1", per spec §10 (lineage_id, kind, statement, steering and enforcement blocks, truth probes, record_hash); main-repo vs repository sharing_scope as specified.' },
  ]
  const built = await parallel(kinds.map(k => () => agent(`${RULES}\n${SPEC}
TASK: Build ${k.what}
The shared wizard shell and the skill wizard already exist on branch ${SHELL_BRANCH} (head ${shell.head_sha || 'see branch'}). Shell notes: ~/Projects/.worktrees/oxagen/creation-wizards/.wizard-shell-notes.md. Shell builder summary: ${shell.summary}
1. cd ~/Projects/oxagen && git fetch origin && git worktree add ~/Projects/.worktrees/oxagen/wizard-${k.slug} -b ${k.branch} origin/${SHELL_BRANCH}; push -u immediately.
2. Plug the ${k.slug} kind into the shell (add it to the Create chooser and its page entry point). Avoid editing shell files; if you must, keep the change minimal and say so. Put i18n messages in their own keys block to minimise merge conflicts with the sibling wizard being built in parallel.
3. Component + action tests. Commit and push often. Do not open a PR — an integrator merges your branch.
Return branch, worktree, head sha, summary, deviations, gaps (ci_state: not-opened).`, { label: `wizard:${k.slug}`, phase: 'Agent + record wizards', schema: RESULT, agentType: 'general-purpose' })))
  const ok = built.filter(Boolean)

  phase('Integrate wizards PR')
  const pr = await agent(`${RULES}\n${SPEC}
TASK: Integrate and ship the creation-wizards PR.
Worktree ~/Projects/.worktrees/oxagen/creation-wizards on branch ${SHELL_BRANCH}. Merge (git merge, no rebase) these finished branches into it and resolve conflicts carefully (i18n messages, Create chooser registry, capability-ui-map.json): ${ok.map(b => b.branch).join(', ')}. Builder summaries: ${JSON.stringify(ok.map(b => ({ branch: b.branch, summary: b.summary, gaps: b.open_gaps })))}. ${built.length !== ok.length ? 'NOTE: one wizard builder failed — build the missing wizard yourself (agent or record, whichever branch is absent) before opening the PR.' : ''}
Also merge origin/main into the branch. Read the combined diff once end to end against the spec and fix anything missing or inconsistent (three wizards must feel like one shell).
Open a PR against main titled around "Oxagen: create a skill, an agent or a context record through a pull request" with a clear-prose body: what ships, entry points, how each maps to creation-spec sections, tests added, any defects fixed on the way, deviations. Use Refs/Closes only for issues that genuinely exist (search gh issues first); otherwise label closes-nothing. Then watch CI (gh pr checks --watch; a conflicting PR gets no run — merge main). Fix every failure and push until green, up to 4 fix rounds; if still red report exactly what fails. Afterwards remove the two sub-wizard worktrees (git worktree remove, then prune); keep the main one.
Return pr_url, head sha, ci_state, summary, deviations, gaps.`, { label: 'integrate', phase: 'Integrate wizards PR', schema: RESULT, agentType: 'general-purpose' })
  return pr
}

async function reposTrack() {
  return agent(`${RULES}\n
SOURCE OF TRUTH:
- ~/Projects/oxagen-roadmap/mockups/pages/repositories.md and repositories.audit-prompt.md (the page, build it exactly), plus how it renders in mockups/missioncontrol.html via mockups/src/engine.js/engine.css (search for the repositories page code).
- ~/Projects/oxagen-roadmap/docs/mission-control-spec.md §10.1 (one main repo, linked repos, production branch, role, issues), §11 (ingestion, production branch §11.4), the wrk.repositories table, and the GitHub event handling table (renames, default-branch change, uninstall each prompt, never silently alter a binding).
- Already merged: PR #3326 (workspace born with its main repository; a second repository links and unlinks). Reuse its contracts/handlers (apps/app/src/data/contracts/repository.ts, packages/oxagen/src/contracts, packages/handlers) — add only what is missing, through the full parity chain.
TASK (one PR):
1. RESUMING (third interruption). The worktree ~/Projects/.worktrees/oxagen/repositories-page on mc/repositories-page already has, pushed: repository tree / production branch / init PR capabilities through contract, API, MCP, CLI; the Repositories page with four tabs, a repository dialog and an init wizard; tests, capability docs and UI-map bindings (all WIP commits; ~79 files). Do NOT recreate anything. Read git log origin/main..HEAD and the diff, audit it against repositories.md, check whether the workspace-menu Settings removal (step 2) is done, finish what is missing, then open the PR. Commit+push after every step (sessions have been dying; unpushed work is lost).
2. Remove Settings from the workspace menu: WorkspaceSettingsButton in apps/app/src/features/shell/sidebar.tsx and the WorkspaceSettingsDialog wiring in shell-client.tsx / shell-state.tsx / features/shell/workspace-settings*. Everything that dialog carried (notably the main repository) must have a home on the Repositories page or wherever the roadmap mockups place it — nothing the operator could do is lost. Update tests and i18n accordingly; remove dead code only when nothing else uses it and it is not listed in DEREGISTERED.md.
3. Ship the entire Repositories page experience as specified in repositories.md: route, nav entry where the mockup places it, main repo + linked repos, production branch confirm/change, last indexed commit, event health, issue import, link/unlink, every state (loaded, empty, loading, error, denied, phone), and every action the mockup shows. Wire to live data via contracts only.
4. Component + action tests, capability-ui-map.json bindings with proof. Commit and push often.
5. Open a PR against main (clear-prose body: what ships, what left the menu and where it went, spec mapping, defects fixed, deviations; Refs/Closes only for real issues, else closes-nothing). Watch CI (gh pr checks --watch), fix and push until green, up to 4 rounds; report exactly what still fails if red.
Return branch, worktree, pr_url, head sha, ci_state, summary, deviations, gaps.`, { label: 'repositories', phase: 'Repositories page', schema: RESULT, agentType: 'general-purpose' })
}

const REVIEW = {
  type: 'object',
  properties: {
    pr_url: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, file: { type: 'string' }, finding: { type: 'string' } }, required: ['severity', 'finding'] } },
    ci_state: { type: 'string' },
  },
  required: ['fixed', 'remaining', 'ci_state'],
}

function review(pr, name, specHint) {
  if (!pr || !pr.pr_url) return null
  return agent(`${RULES}\nReview PR ${pr.pr_url} (branch ${pr.branch}, worktree ${pr.worktree || 'create one under ~/Projects/.worktrees/oxagen/'}) cold, against ${specHint}. Check: spec fidelity (steps, copy, states, entry points), the never-do list, tenancy/IAM on any new handler, capability parity and ui-parity bindings, tests present for every new component/action, clear-prose on strings. Fix every P0/P1 you confirm directly on the branch, commit, push, then watch CI green again (up to 3 rounds). Leave P2 and below as findings (do not file issues). Return what you fixed, what remains with severities, and final ci_state.`, { label: `review:${name}`, phase: 'Review', schema: REVIEW, agentType: 'general-purpose' })
}

const [wiz, repos] = await parallel([
  () => wizardsTrack().then(async pr => ({ pr, review: await review(pr, 'wizards', '~/Projects/oxagen-roadmap/docs/creation-spec.md, mockups/src/engine.js (wz*), mockups/pages/{skills,agents,steering,record}.md') })),
  () => reposTrack().then(async pr => ({ pr, review: await review(pr, 'repositories', '~/Projects/oxagen-roadmap/mockups/pages/repositories.md and oxagen-roadmap docs/mission-control-spec.md §10.1/§11') })),
])
return { wizards: wiz, repositories: repos }
