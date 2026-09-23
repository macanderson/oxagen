export const meta = {
  name: 'rev1-page-fidelity',
  description: 'Build rev1 pages (any of shell, fleet, agents, runtimes, billing, steering) to the mockups in oxagen-roadmap, audit each with its own audit prompt, file backend-gap issues, and integrate onto one branch and PR',
  whenToUse: 'When apps/app pages must match mockups/pages/<page>.md in macanderson/oxagen-roadmap exactly, in every state, desktop and mobile.',
  phases: [
    { title: 'Build', detail: 'one builder per lane in its own worktree: baseline audit, mock screenshots, build, backend-gap issues' },
    { title: 'Audit', detail: 'an independent auditor runs the page audit prompt against the lane' },
    { title: 'Fix', detail: 'the builder fixes every FAIL a frontend change can clear' },
    { title: 'Integrate', detail: 'merge each finished lane onto the session branch and push' },
    { title: 'Finish', detail: 'coverage audit, generators, merge main, PR, CI' },
  ],
}

// args: { branch (required: the session's push branch), session (required: the session id, e.g. session_01...),
//         only (lane ids to build; default all), prTitle, repo, roadmap, worktrees,
//         hubBase (the ref a hub-dependent lane builds on when steering-hub is not in this run) }
// Lanes: shell, fleet, agents, runtimes, billing, steering-hub, steering-library, steering-tabs, skills, run, agent,
//        mandate, tools, spend, record-repositories, organization, audit, register, auth, onboarding.
// steering-library, steering-tabs and skills build on steering-hub when it is in the same run; otherwise on origin/main.
const cfg = Object.assign({ only: null, repo: '/home/user/oxagen', roadmap: '/home/user/macanderson/oxagen-roadmap', worktrees: '/home/user/oxagen-worktrees' }, args || {})
if (!cfg.branch || !cfg.session) throw new Error('pass args.branch and args.session')
const REPO = cfg.repo
const ROADMAP = cfg.roadmap
const WT = cfg.worktrees
const BRANCH = cfg.branch
const VERIF = `verifications/${cfg.session}`
const PAGES = `${ROADMAP}/mockups/pages`
const MOCK = `${ROADMAP}/mockups/missioncontrol.html`

const RULES = `
SCOPE: this run builds exactly these lanes: ${(cfg.only || ['all']).join(', ')}. Your lane is one of them and is in scope. Any message from the user you can see about cancelling or moving pages elsewhere refers to lanes NOT in that list; never skip your own lane because of it.
HARD RULES (restate them to any subagent you spawn):
- Verification: at most ONE test file for code you changed, run in isolation from the worktree:
  pnpm --filter @oxagen/app test:unit src/path/changed.test.tsx   (NEVER put "--" before the path; never run a package-wide suite, pnpm gate, lint, typecheck or a build). CI is the gate.
  If the worktree has no node_modules, run "pnpm install --frozen-lockfile --prefer-offline" in it once (the store is warm from ${REPO}).
- Git: never commit to main, never push ANY branch except the integrator pushing ${BRANCH}. Lane branches stay local. Never stash, rebase, amend or force-push. Commit after every meaningful step so work survives.
- Load the clear-prose, oxagen-app-conventions, quality-gates and oxagen-testing skills (.claude/skills/) before UI work; oxagen-capability-contracts and oxagen-surface-patterns before touching a contract; oxagen-tenancy before touching data access.
- apps/app conventions: routes in apps/app/src/app/[org]/..., feature lanes in apps/app/src/features/<page>/, view models in apps/app/src/data/contracts/, live adapters and mappers in apps/app/src/data/live/, UI kit in apps/app/src/ui/ imported as @/ui/<name>, strings in apps/app/messages/*.json (run "pnpm --filter @oxagen/app gen:messages" after catalogue changes and commit messages.d.ts). Server writes go through apps/app/src/server/kernel.ts. Read apps/app/ARCHITECTURE.md §1.2, §3, §4, §6 first.
- Production has no fixtures. Where the backend has no store for an element, render the app's NotBacked state (find the existing NotBacked / not-recorded pattern in src/data/unrecorded.ts and src/ui) naming what is missing. A fixture or invented number reaching production is a FAIL. Every trust badge shows the recorded value and nothing stronger. Every money figure shows its basis.
- A capability given an "app" layer needs its apps/app/capability-ui-map.json binding and a component or action test as proof (check:ui-parity --strict).
- No fourth Playwright spec. New routes go in apps/app/e2e/routes.ts for page-load.
- Read DEREGISTERED.md before removing a feature's files.
- Never edit, commit to, or add files in the oxagen-roadmap clone. The spec and audit prompt are fixed. A deviation you cannot avoid is not written into the spec: list it under deviations in your result, and the auditor marks its check FAIL.
- Plain-noun headings: no comma, mid-dot or not/never contrast in a heading or label; subtext under a heading is one sentence or nothing. Exactly one gold action per screen.
- Open PRs that overlap this work (read their diffs with the GitHub MCP pull_request_read tool, loaded via ToolSearch, on macanderson/oxagen): #3776 "resurface existing Fleet, Run and Steering functions" and #3777 "resurface shell activity and organization sections". Do not duplicate what they add; build compatibly with them and name any overlap in your result.
`

const MOCK_HOWTO = `
THE DESIGN: ${PAGES}/<spec>.md is the spec and <spec>.audit-prompt.md its audit. ${ROADMAP}/mockups/README.md and pages/README.md explain the design. The rendered mock is ${MOCK} (renderer ${ROADMAP}/mockups/src/engine.js and engine.css, fixtures in mockups/fixtures, states per page in mockups/catalog.mjs). Open it as file://${MOCK}?product=1&state=<loaded|empty|loading|error|denied>&mobile=<0|1>#<route> .
Screenshot every state the catalog lists for your pages, desktop (1440x900) and mobile (390x844), with Chromium via Playwright (the Playwright MCP browser tools, loaded with ToolSearch "playwright", or a node script using playwright-core with executablePath "/opt/pw-browsers/chromium"; never run "playwright install"). Save them under ${REPO}/${VERIF}/<lane>/mock/ (gitignored) and look at them. "Exactly like the mock" means: the same regions in the same order, the same copy verbatim, the same columns, tiles, chips, badges, dialogs and actions, the same state copy, the same mobile behaviour. Map the mock's CSS (engine.css variables) to the app's house tokens in apps/app/src/app/globals.css and packages/ui/src/styles/globals.css; do not copy the mock's CSS wholesale, and use the component tokens named in AGENTS.md for shell chrome.
`

const ISSUE_RULES = `
BACKEND GAPS: an element whose data or write has no backend today is rendered NotBacked and gets a GitHub issue on macanderson/oxagen (GitHub MCP issue_write, loaded with ToolSearch; search_issues first and reuse an open issue that already covers it: add a comment instead of a duplicate, naming this page's audit check). One issue per full change; group gaps that are one backend change. Issue shape:
- Title: "Queued · <area>/<surface> · <sentence about the system>" (area is one of app, surfaces, kernel, auth, billing, knowledge, evidence, data, platform, ops; surface e.g. Steering, Fleet, Agents, Runtimes, Billing, Postgres, ClickHouse). Apply ONLY the "triage" label.
- Body (clear-prose): Context (the page, the spec section in oxagen-roadmap mockups/pages/<spec>.md, the audit check numbers it fails), paths in this repo, what is missing in which store/contract/handler, proposed approach, and a "- [ ]" definition of done whose items include the backend work, the contract/API/MCP/CLI/docs parity, tests, wiring the page element off NotBacked, and, always last: "- [ ] Re-run mockups/pages/<spec>.audit-prompt.md (macanderson/oxagen-roadmap) against the build; every check prints PASS." Add an "Issue metadata" section: Estimated agent minutes, Impacts schema (Yes/No), Breaking change (Yes/No), Customer reported: No. End the body with a blank line, "---", and "_Generated by [Claude Code](https://claude.ai/code)_".
`

const LANES = [
  {
    id: 'shell', specs: ['audit-prompt'], routes: 'every page (the shell)',
    owns: 'apps/app/src/features/shell/**, the shared layout under apps/app/src/app/[org]/ (layout.tsx files), shared state components in apps/app/src/ui/ for the not-loaded states (skeleton, error, access denied) that every page uses, apps/app/messages namespace "shell"',
    task: `The shared shell every page spec describes, from ${PAGES}/audit-prompt.md (the whole-app prompt: shell, approvals drawer, mobile shell, cross-cutting rules) and the "Shell" and "Mobile" sections of fleet.md, steering.md, agents.md, runtimes.md and billing.md: sidebar (organization switcher, workspace switcher, Workspace nav Fleet · Agents · Tools · Steering · Runtimes · Repositories · Spend with the counts only where something waits on a person; Organization nav Organization · Billing · Audit; foot: assistant launcher, agent count · data plane, connection badge; no Skills entry), top bar (breadcrumbs, ⌘K search-or-run, notifications with unread dot, the Approvals button left of the avatar with the org-wide count opening the #apdrawer right-hand drawer with the list, the full approval card, Approve and Deny, Escape to close; no assistant button; user menu items), the mobile shell (collapsed top bar, five-slot thumb bar Fleet · Agents · Tools · Spend · More, the More bottom sheet contents, hamburger drawer over a scrim, bottom-sheet dialogs), and the shared not-loaded states: loading skeleton (four tile blocks and a panel of seven rows, shell stays), error (title, the control-plane code, the three sentences, Try again, Open an incident, trace line), access denied (title, sentence naming the permission, Request access, Back to Fleet, Signed in as, Needed, Decided by). Build those three state components once so every page lane can pass its own copy into them. The Runtimes nav item must route to /[org]/[ws]/runtimes (the runtimes lane builds that page).`,
  },
  {
    id: 'fleet', specs: ['fleet'], routes: '/[org]/[ws] (Fleet)',
    owns: 'apps/app/src/features/fleet/**, apps/app/src/app/[org]/[ws]/(fleet)/**, apps/app/src/data/live/runs.ts and approvals.ts with their contracts and mappers, messages namespace "fleet"',
    task: 'Fleet exactly as fleet.md: header and its two non-gold actions with the steerfleet dialog, the four summary tiles with their basis lines, the Runs panel with its filter chips, columns, action column, list controls and pager, the first-run banners, and every state. The approvals drawer and card are built by the shell lane; Fleet\'s "Waiting on a human" tile opens it, so coordinate by calling the drawer\'s open API or event the shell lane exposes (read features/shell on the base and the #3777 diff; if none exists, dispatch a documented DOM event "oxagen:open-approvals" and note it in your result so the integrator wires it).',
  },
  {
    id: 'agents', specs: ['agents'], routes: '/[org]/[ws]/agents',
    owns: 'apps/app/src/features/agents/agents.tsx and the list-level files beside it (not the agent detail files), apps/app/src/app/[org]/[ws]/agents/page.tsx, apps/app/src/data/live/agents.ts list paths and their contracts, messages namespace "agents"',
    task: 'The Agents list page exactly as agents.md (not the agent detail page agent.md): header, tiles, column-set toggle, table columns, row actions, dialogs, and every state.',
  },
  {
    id: 'runtimes', specs: ['runtimes'], routes: '/[org]/[ws]/runtimes and /[org]/[ws]/runtimes/[runtime]',
    owns: 'new apps/app/src/features/runtimes/**, new apps/app/src/app/[org]/[ws]/runtimes/**, new data contract and live adapter for runtimes, messages namespace "runtimes"',
    task: 'Runtimes is a new page: build the host list and one host exactly as runtimes.md, in every state (the detail has no empty state). Enrollment is recorded per agent today (see the tacho enrollment tables and the agent enrollment components in features/agents/enrollment*.tsx): read what exists, render what the record carries honestly, render NotBacked for the host row, the per-host tier rollup, the 24-hour gap count, the settings file read back, and the per-host checkpoint, and file issues for them.',
  },
  {
    id: 'billing', specs: ['billing'], routes: '/[org]/billing',
    owns: 'apps/app/src/features/billing/**, apps/app/src/app/[org]/billing/**, apps/app/src/data/live/billing.ts and its contract, messages namespace "billing"',
    task: 'Organization Billing exactly as billing.md: every region, table, meter, dialog and state, with billing pricing the governed action (ADR-055). Existing Stripe checkout, plan change, auto top-up and purchase flows must keep working; reshape them to the design rather than deleting them (DEREGISTERED.md first).',
  },
  {
    id: 'steering-hub', specs: ['steering'], routes: '/[org]/[ws]/steering[/<tab>[/...]]',
    owns: 'apps/app/src/app/[org]/[ws]/steering/**, apps/app/src/features/steering/{steering,tabs,section,view,status}.tsx|ts and new hub files (governance chip and dialog, Library All shelf, shelf row), apps/app/src/data/live/steering.ts and its contract, messages namespace "steering"',
    task: 'The Steering hub exactly as steering.md: hub header with the governance chip and govmode dialog (confirming opens a Context PR through the existing context PR capability if one exists, else NotBacked plus an issue for writing governance.toml), the five tabs Library · Assignments · Gates · Proposals · Compiler as URL path segments (convert the current query-value tabs; every old URL in the spec lands, including /skills… and /steering/records|memory|ontology|policy|preview|prs; the existing /steering/records/[lineage] record page keeps working), the Library shelf row with aria-pressed chips, the Library All shelf (stat strip, lead note verbatim, Everything written down table with its columns and assembler order), and every state. For the Assignments, Gates, Proposals and Compiler tabs and the Records, Memory and Ontology shelves, create the route segments and a minimal body component per tab in its own file (tabs/<tab>.tsx) that the steering-library and steering-tabs lanes will fill; keep existing Records, Skills and Proposals content working inside the right tab/shelf.',
  },
  {
    id: 'steering-library', specs: ['steering-records', 'steering-memory', 'steering-ontology'], routes: '/[org]/[ws]/steering/records|memory|ontology', dependsOn: 'steering-hub',
    owns: 'the Records, Memory and Ontology shelf body files under apps/app/src/features/steering/ that the hub lane created, their data contracts and live adapters, messages sub-keys for those shelves',
    task: 'Fill the Records, Memory and Ontology shelves of the Steering Library exactly as steering-records.md, steering-memory.md and steering-ontology.md, in every state each spec lists.',
  },
  {
    id: 'steering-tabs', specs: ['steering-assignments', 'steering-gates', 'steering-proposals', 'steering-compiler'], routes: '/[org]/[ws]/steering/assignments|gates|proposals|compiler', dependsOn: 'steering-hub',
    owns: 'the Assignments, Gates, Proposals and Compiler tab body files under apps/app/src/features/steering/ that the hub lane created (plus the existing proposals/context-pr files), their data contracts and live adapters, messages sub-keys for those tabs',
    task: 'Fill the Assignments, Gates, Proposals and Compiler tabs of Steering exactly as steering-assignments.md, steering-gates.md, steering-proposals.md and steering-compiler.md, in every state each spec lists. The Compiler reads the one assembler (packages/steering-assembler) through whatever capability exposes it; where none exists, NotBacked plus an issue.',
  },
  {
    id: 'skills', specs: ['skills', 'skills-off', 'skill-source'], routes: '/[org]/[ws]/steering/skills[/<view>] and /steering/skills/<id>/source (the old /[org]/[ws]/skills… routes redirect there)', dependsOn: 'steering-hub',
    owns: 'apps/app/src/features/skills/**, apps/app/src/app/[org]/[ws]/skills/**, the Skills shelf route under apps/app/src/app/[org]/[ws]/steering/, apps/app/src/data/live/skills.ts and its contract, messages namespace "skills"',
    task: 'The Skills shelf of the Steering Library exactly as skills.md, skills-off.md (the off-by-default gate, loaded state only) and skill-source.md (no empty state): sync, resolution, the seat in the loop, reflection, the cited rate, the interjection, and every state. Skills has no nav entry; it is a shelf, and the shelf row from the hub shows on it. If the steering hub is not on your base, build the shelf body and routes so the hub can mount them, and note it under coordination.',
  },
  {
    id: 'run', specs: ['run', 'run-interjection'], routes: '/[org]/[ws]/runs/[run]',
    owns: 'apps/app/src/features/run/**, apps/app/src/app/[org]/[ws]/runs/**, apps/app/src/data/live/runs.ts run-detail paths and data/contracts/run.ts, messages namespace "run"',
    task: 'The Run page exactly as run.md and run-interjection.md: the generated summary, the stat row (Tokens, Prompts, Cost, Wasted, Wall clock, Cache hit), the tabs (Transcript, Issues, Governed actions, Cost, Policy, Context, Chain and seal) in the two-thirds column, the right-hand Repository panel, outputs and spend by area, the interjection card and its answer flow, every dialog and every state. Open PRs #3778, #3779 and #3773 touch run outcomes, checkout evidence and run summaries: read their diffs and build compatibly.',
  },
  {
    id: 'agent', specs: ['agent', 'agent-source'], routes: '/[org]/[ws]/agents/[agent][/<tab>] and /[org]/[ws]/agents/[agent]/source',
    owns: 'the agent detail files in apps/app/src/features/agents/ (agent.tsx, agent-source.tsx, identity, enrollment, toolbelt, budget-panel, role-controls, kill-switch, incidents, mandates, definition*, source-editor and their tests; not agents.tsx), apps/app/src/app/[org]/[ws]/agents/[agent]/**, agent-detail paths in data/live/agents.ts, messages sub-keys for the agent detail',
    task: 'The agent detail exactly as agent.md (every tab: overview, Toolbelt, Steering, Runtime, Permissions, Activity, with the coaching strip in place of any score) and agent-source.md, in every state each lists. The Agents list page belongs to another lane; do not edit agents.tsx.',
  },
  {
    id: 'mandate', specs: ['mandate'], routes: '/[org]/[ws]/mandates/[mandate] (the design route is /agents/<agent>/mandates/<id>; make both land)',
    owns: 'apps/app/src/features/mandate/**, apps/app/src/app/[org]/[ws]/mandates/**, a mandate route under agents/[agent]/ if the design needs it, data/live/mandates.ts and its contract, messages namespace "mandate"',
    task: 'The Mandate page exactly as mandate.md: every region, the grant and ledger, dialogs, and every state.',
  },
  {
    id: 'tools', specs: ['tools'], routes: '/[org]/[ws]/tools[/<tab>]',
    owns: 'apps/app/src/features/tools/**, apps/app/src/app/[org]/[ws]/tools/**, data/live/tools.ts and its contract, messages namespace "tools"',
    task: 'The Tools page exactly as tools.md, all five of its tabs (Toolbelts and Providers among them) as URL path segments, with every table, dialog, the auto-approval rules and every state.',
  },
  {
    id: 'spend', specs: ['spend'], routes: '/[org]/[ws]/spend[/<tab>]',
    owns: 'apps/app/src/features/spend/**, apps/app/src/app/[org]/[ws]/spend/**, data/live/spend.ts and its contract, messages namespace "spend"',
    task: 'The Spend page exactly as spend.md, including the Tokens tab (the month by class, by prompt part, by harness with its basis, by agent) and the Coaching tab, with every money figure showing its basis and every state.',
  },
  {
    id: 'record-repositories', specs: ['record', 'repositories'], routes: '/[org]/[ws]/steering/records/[lineage] and /[org]/[ws]/repositories[/<tab>]',
    owns: 'apps/app/src/features/record/**, apps/app/src/features/repositories/**, apps/app/src/app/[org]/[ws]/steering/records/[lineage]/**, apps/app/src/app/[org]/[ws]/repositories/**, their data contracts and live adapters, messages namespaces "record" and "repositories"',
    task: 'The context record page exactly as record.md (no empty state) and Repositories exactly as repositories.md, in every state. The creation wizards that end at these pages are specified in docs/creation-spec.md in oxagen-roadmap; keep the existing wizards in apps/app/src/features/create working.',
  },
  {
    id: 'organization', specs: ['organization', 'organization-api-keys', 'organization-roles'], routes: '/[org], /[org]/api-keys, /[org]/roles',
    owns: 'apps/app/src/features/organization/** except model-funding* and sso* files, apps/app/src/app/[org]/page.tsx, apps/app/src/app/[org]/api-keys/**, apps/app/src/app/[org]/roles/**, data/live/org.ts and its contract, messages namespace "organization"',
    task: 'Organization, API keys and Roles exactly as organization.md, organization-api-keys.md and organization-roles.md: people, invitations, workspaces with their governance mode read off the workspace, keys, roles, every dialog and every state. Model funding and SSO have no mock spec: leave them working and reachable. Open PR #3777 resurfaces organization sections: read its diff and build compatibly.',
  },
  {
    id: 'audit', specs: ['audit'], routes: '/[org]/audit',
    owns: 'apps/app/src/features/audit/**, apps/app/src/app/[org]/audit/**, data/live/audit.ts and its contract, messages namespace "audit"',
    task: 'The Audit page exactly as audit.md: filters, the event table, export, incidents, every dialog and every state.',
  },
  {
    id: 'register', specs: ['register-name', 'register-wrap', 'register-run'], routes: '/[org]/[ws]/register/[step] (name, wrap, run)',
    owns: 'apps/app/src/app/[org]/[ws]/register/**, the register files in apps/app/src/features/onboarding/ (register.tsx, gate.tsx, rail.tsx, steps.ts, agent-form.ts and their tests), messages sub-keys for register',
    task: 'The three-step Register Agent gate exactly as register-name.md, register-wrap.md and register-run.md, in the states each lists (name and wrap: loaded, loading, denied; run: also error). The onboarding lane shares features/onboarding: touch only the register files.',
  },
  {
    id: 'auth', specs: ['signup', 'verify-email', 'login', 'two-factor', 'forgot-password', 'reset-password', 'accept-invitation'], routes: '/signup, /verify, /login, /two-factor, /forgot-password, /reset-password, /invite/[token]',
    owns: 'apps/app/src/features/auth/** (not cli-* files), apps/app/src/app/(auth)/**, messages namespace "auth"',
    task: 'The seven sign-in screens exactly as their specs, in the states each lists (none has an empty state). Login, sign-up and payment are covered by the login and pay Playwright specs in apps/app/e2e: keep every selector those specs use working, and do not change auth behaviour, only its presentation and copy. Better Auth rate limiting and the CLI consent flow must keep working.',
  },
  {
    id: 'onboarding', specs: ['onboarding-organization', 'onboarding-wrap', 'onboarding-run', 'installer'], routes: '/new-organization and the onboarding wrap, run and installer steps the specs name',
    owns: 'apps/app/src/app/(onboarding)/**, the onboarding files in apps/app/src/features/onboarding/ (new-organization.tsx, org-form.ts, actions.ts, ui/ and their tests; not the register files), messages namespace "onboarding"',
    task: 'The onboarding gate exactly as onboarding-organization.md, onboarding-wrap.md, onboarding-run.md and installer.md, in the states each lists (the installer has loaded and error). Wrap, run and installer have no route today: add them where the spec places them, and keep the post-signup redirect to Fleet working.',
  },
]

const LANE_RESULT = {
  type: 'object',
  properties: {
    lane: { type: 'string' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    head_sha: { type: 'string' },
    summary: { type: 'string' },
    baseline: { type: 'string', description: 'baseline audit on origin/main: counts of PASS/FAIL/N/A per spec and the worst gaps' },
    files_touched: { type: 'array', items: { type: 'string' } },
    tests_run: { type: 'array', items: { type: 'string' }, description: 'each test file run and its result' },
    issues: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, new: { type: 'boolean' }, checks: { type: 'string' } }, required: ['url', 'title'] } },
    coordination: { type: 'array', items: { type: 'string' }, description: 'anything another lane or the integrator must wire' },
    deviations: { type: 'array', items: { type: 'string' } },
  },
  required: ['lane', 'branch', 'worktree', 'head_sha', 'summary', 'issues'],
}

const AUDIT = {
  type: 'object',
  properties: {
    lane: { type: 'string' },
    head_sha: { type: 'string' },
    report_path: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          spec: { type: 'string' },
          n: { type: 'string' },
          check: { type: 'string' },
          result: { type: 'string', enum: ['PASS', 'FAIL', 'N/A'] },
          evidence: { type: 'string' },
          fix: { type: 'string' },
          blocked_by_backend: { type: 'boolean', description: 'true only when the fail cannot clear without backend work that a filed issue covers' },
          issue_url: { type: 'string' },
        },
        required: ['spec', 'n', 'check', 'result', 'evidence', 'blocked_by_backend'],
      },
    },
  },
  required: ['lane', 'head_sha', 'checks'],
}

const FINAL = {
  type: 'object',
  properties: {
    pr_url: { type: 'string' },
    head_sha: { type: 'string' },
    ci_state: { type: 'string' },
    ci_failures: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    lanes_merged: { type: 'array', items: { type: 'string' } },
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
  },
  required: ['head_sha', 'ci_state', 'summary', 'lanes_merged'],
}

function specList(lane) { return lane.specs.map(s => `${PAGES}/${s}.md and ${PAGES}/${s}.audit-prompt.md`).join('; ') }

function buildPrompt(lane, base) {
  return `${RULES}\n${MOCK_HOWTO}\n${ISSUE_RULES}
TASK: lane "${lane.id}". Make ${lane.routes} in apps/app match the rev1 design exactly, in every state, desktop and mobile.
Specs and audit prompts: ${specList(lane)}.
1. Setup: git -C ${REPO} fetch origin; git -C ${REPO} worktree add ${WT}/${lane.id} -b page/${lane.id} ${base}. Work only in that worktree. Do not push.
2. Baseline: read the spec(s) in full, then run the audit prompt(s) yourself against the current code (read the files; {{APP_ROOT}} is ${WT}/${lane.id}/apps/app). Record every check's PASS/FAIL with evidence in ${REPO}/${VERIF}/${lane.id}/baseline.md.
3. Screenshot the mock in every state the catalog lists for these pages, desktop and mobile, and study them.
4. Build: ${lane.task}
   You own: ${lane.owns}. Touch shared files (messages outside your namespace, capability-ui-map.json, data/ports.ts, data/contracts/common.ts, e2e/routes.ts) only in the smallest hunk your lane needs. Do not edit the shell (features/shell, app layouts) unless you are the shell lane: list shell needs under coordination.
   Every state from the spec: loaded, empty, loading, error, access denied (as the spec lists them), with the spec's copy verbatim, and the mobile behaviour. Reuse the shell lane's shared state components if they exist on your base; otherwise use the app's existing state components and note it under coordination.
   Server-side permission checks on reads and every write (the permission the spec names, mapped to the real IAM capability).
5. Tests: a co-located component test for each new or changed component covering every state and the key interactions (tabs, chips, dialogs, aria attributes, verbatim copy), and an action test for each server action. Run each changed test file alone once. Commit.
6. Backend gaps: render NotBacked and file or reuse issues per BACKEND GAPS. Every issue's DoD ends with re-running the audit prompt to all PASS.
7. Commit everything on page/${lane.id}. Return the structured result with the worktree's HEAD sha.`
}

function auditPrompt(lane, built, round) {
  return `${RULES}\n${MOCK_HOWTO}
TASK: independent audit (round ${round}) of lane "${lane.id}" at ${built.worktree} (branch ${built.branch}, HEAD ${built.head_sha}). You did not build this. Be exact and adversarial: the design is the spec and close enough is a FAIL. Do not edit source files.
Run each audit prompt in full, check by check: ${lane.specs.map(s => `${PAGES}/${s}.audit-prompt.md`).join(', ')}. {{APP_ROOT}} is ${built.worktree}/apps/app; there is no running server, so cite file:line and rendered output from the component tests (you may run ONE test file at a time to see what renders) and compare against mock screenshots you take (desktop and mobile, every state). Shell checks (sidebar, top bar, approvals drawer, mobile thumb bar) belong to the shell lane: mark them N/A with "shell lane" unless this lane is the shell lane.
Issues the builder filed for backend gaps: ${JSON.stringify(built.issues || [])}. Mark a FAIL blocked_by_backend=true only when it truly cannot clear without that backend work AND the page renders NotBacked honestly for it; otherwise it is a frontend FAIL. A fixture or invented value in production code is a FAIL.
Write the report in the prompt's output format to ${REPO}/${VERIF}/${lane.id}/audit-round-${round}.md and return every check as structured data.`
}

function fixPrompt(lane, built, audit, round) {
  const fails = audit.checks.filter(c => c.result === 'FAIL' && !c.blocked_by_backend)
  const blocked = audit.checks.filter(c => c.result === 'FAIL' && c.blocked_by_backend && !c.issue_url)
  return `${RULES}\n${MOCK_HOWTO}\n${ISSUE_RULES}
TASK: fix round ${round} for lane "${lane.id}" in ${built.worktree} on ${built.branch} (HEAD ${built.head_sha}). The independent audit (${REPO}/${VERIF}/${lane.id}/audit-round-${round}.md) failed these checks that a frontend change can clear:
${JSON.stringify(fails.map(c => ({ spec: c.spec, n: c.n, check: c.check, evidence: c.evidence, fix: c.fix })), null, 1)}
Fix every one to the spec (${lane.specs.join(', ')}). If you prove a FAIL truly needs backend work, render NotBacked and file or reuse an issue for it.
Backend-blocked FAILs without an issue yet (file or reuse one each): ${JSON.stringify(blocked.map(c => ({ spec: c.spec, n: c.n, check: c.check })))}
Update tests; run each changed test file alone once; commit. Return the structured result with all issues (old and new) and the new HEAD sha.`
}

let chain = Promise.resolve()
function serial(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p }

function integratePrompt(lane, built) {
  return `${RULES}
TASK: integrate lane "${lane.id}" onto ${BRANCH} in ${REPO} (the main checkout, already on ${BRANCH}).
1. git -C ${REPO} status must be clean; git -C ${REPO} checkout ${BRANCH}. Verify git -C ${REPO} rev-parse page/${lane.id} equals ${built.head_sha}; stop and report on a mismatch.
2. git merge --no-ff page/${lane.id} -m "Merge ${lane.id} lane". Resolve conflicts by keeping both sides' hunks in messages, capability-ui-map.json, data contracts, ports and e2e/routes.ts; for code both lanes changed, read both and keep both behaviours. Lanes already merged: see git log.
3. Coordination notes from this lane to wire now if the other side is present: ${JSON.stringify(built.coordination || [])}.
4. If messages changed, run pnpm --filter @oxagen/app gen:messages (install deps in ${REPO} first if missing) and commit messages.d.ts.
5. git push -u origin ${BRANCH} (retry up to 4 times on network errors with 2s, 4s, 8s, 16s backoff). Return a short text: merged sha, conflicts resolved, anything left unwired.`
}

async function runLane(lane, base) {
  let built = await agent(buildPrompt(lane, base), { label: `build:${lane.id}`, phase: 'Build', schema: LANE_RESULT, agentType: 'general-purpose' })
  if (!built) { log(`lane ${lane.id}: build agent failed`); return null }
  let audit = null
  for (let round = 1; round <= 3; round++) {
    audit = await agent(auditPrompt(lane, built, round), { label: `audit:${lane.id}:r${round}`, phase: 'Audit', schema: AUDIT, agentType: 'general-purpose' })
    if (!audit) { log(`lane ${lane.id}: audit round ${round} failed`); break }
    const fails = audit.checks.filter(c => c.result === 'FAIL' && !c.blocked_by_backend)
    const blockedNoIssue = audit.checks.filter(c => c.result === 'FAIL' && c.blocked_by_backend && !c.issue_url)
    log(`lane ${lane.id} round ${round}: ${audit.checks.filter(c => c.result === 'PASS').length} pass, ${fails.length} frontend fail, ${audit.checks.filter(c => c.blocked_by_backend).length} backend-blocked`)
    if (!fails.length && !blockedNoIssue.length) break
    if (round === 3) { log(`lane ${lane.id}: ${fails.length} frontend fails remain after 3 rounds`); break }
    const fixed = await agent(fixPrompt(lane, built, audit, round), { label: `fix:${lane.id}:r${round}`, phase: 'Fix', schema: LANE_RESULT, agentType: 'general-purpose' })
    if (fixed) built = { ...built, ...fixed, issues: [...(built.issues || []), ...(fixed.issues || [])] }
  }
  return { lane: lane.id, built, audit }
}

const lanes = cfg.only ? LANES.filter(l => cfg.only.includes(l.id)) : LANES
if (!lanes.length) throw new Error('args.only named no known lane')
const PR_TITLE = cfg.prTitle || `feat(app): match ${lanes.map(l => l.id).join(', ')} to the rev1 mockups`
log(`lanes: ${lanes.map(l => l.id).join(', ')} on ${BRANCH}`)

// The roadmap repo is public; clone it once if this machine lacks it.
await agent(`Run: test -d ${ROADMAP}/mockups/pages || (mkdir -p $(dirname ${ROADMAP}) && GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/macanderson/oxagen-roadmap ${ROADMAP}). Allow up to 10 minutes. Then run: test -d ${REPO}/node_modules || (cd ${REPO} && pnpm install --frozen-lockfile). Then: git -C ${REPO} checkout ${BRANCH} || git -C ${REPO} checkout -b ${BRANCH} origin/main. Report "ready" or the error.`, { label: 'setup', phase: 'Build', effort: 'low' })

let hubResolve
const hubReady = new Promise(r => { hubResolve = r })
if (!lanes.some(l => l.id === 'steering-hub')) hubResolve(null)

const results = await parallel(lanes.map(lane => async () => {
  let base = 'origin/main'
  if (lane.dependsOn === 'steering-hub') {
    const hub = await hubReady
    if (hub) base = `page/steering-hub`
    else if (cfg.hubBase) base = cfg.hubBase
    else log(`${lane.id}: no steering-hub lane in this run (or it failed); building from origin/main`)
  }
  const r = await runLane(lane, base)
  if (lane.id === 'steering-hub') hubResolve(r && r.built)
  if (!r) return null
  const merged = await serial(() => agent(integratePrompt(lane, r.built), { label: `integrate:${lane.id}`, phase: 'Integrate', agentType: 'general-purpose' }))
  return { ...r, merged }
}))

const done = results.filter(Boolean)
const scoreboard = done.map(r => ({
  lane: r.lane,
  pass: r.audit ? r.audit.checks.filter(c => c.result === 'PASS').length : null,
  frontend_fail: r.audit ? r.audit.checks.filter(c => c.result === 'FAIL' && !c.blocked_by_backend).map(c => `${c.spec}#${c.n} ${c.check}`) : null,
  backend_blocked: r.audit ? r.audit.checks.filter(c => c.result === 'FAIL' && c.blocked_by_backend).map(c => `${c.spec}#${c.n} ${c.issue_url || 'no issue'}`) : null,
  issues: (r.built.issues || []).map(i => i.url),
  merged: r.merged,
}))

phase('Finish')
await agent(`${RULES}
TASK: test coverage audit of the combined change on ${BRANCH} in ${REPO} (git diff origin/main...${BRANCH}). For each new or changed component, server action, adapter and mapper, confirm a co-located test covers its states and branches; write the missing tests, run each new test file alone once, commit, and git push origin ${BRANCH}. Do not lower any coverage threshold. Return a short list of tests added.`, { label: 'coverage', phase: 'Finish', agentType: 'test-engineer' })

const final = await agent(`${RULES}
TASK: finish ${BRANCH} in ${REPO} and open its PR.
1. git fetch origin; git merge origin/main (never rebase); resolve conflicts keeping both behaviours; run pnpm --filter @oxagen/app gen:messages if messages changed and commit. Make sure every new route is in apps/app/e2e/routes.ts and apps/app/ARCHITECTURE.md §1.2 rows reflect the new and changed pages (Runtimes is new). Push.
2. Read the whole diff once against the scoreboard below; fix anything inconsistent between lanes (duplicate state components, two drawers, unwired coordination notes). Push.
3. Open a PR (GitHub MCP create_pull_request, loaded with ToolSearch) from ${BRANCH} into main, ready for review, titled "${PR_TITLE}". Body per .github/PULL_REQUEST_TEMPLATE.md (clear-prose): what ships per page, the audit scoreboard per lane (pass, remaining frontend fails, backend-blocked checks with their issues), "Refs #N" for every backend-gap issue (never Closes), defects fixed along the way, verification (which single test files ran; what is unverified), and end with:
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/${cfg.session}
   If the diff adds no schema change, say so.
4. Watch CI on the PR head (GitHub MCP pull_request_read / get_check_run / get_job_logs). Fix every failure caused by this change and push, up to four rounds; a check red on main too is not this PR's: name it. Report exactly what still fails.
Scoreboard: ${JSON.stringify(scoreboard)}
Return the structured result.`, { label: 'finish', phase: 'Finish', schema: FINAL, agentType: 'general-purpose' })

return { scoreboard, final }
