<!-- Generated: 2026-07-06, corrections applied 2026-07-10 | Files scanned: 634 (app) + 492 (cli) | Token estimate: ~950 -->

# Frontend Architecture

## apps/app — Next.js 16 Web Application (16.2.10)

### Entry Points
```
apps/app/src/app/layout.tsx              → root layout (fonts, providers)
apps/app/src/app/page.tsx               → root redirect
apps/app/src/app/(auth)/layout.tsx      → unauthenticated shell
apps/app/src/app/[orgSlug]/layout.tsx   → org shell (sidebar, nav)
apps/app/src/app/[orgSlug]/[workspaceSlug]/layout.tsx → workspace shell
```

### Page Tree
```
/                                        → redirect to org
/(auth)
  /login                                 → LoginPage
  /signup                                → SignupPage
  /forgot-password                       → ForgotPasswordPage
  /reset-password                        → ResetPasswordPage
  /two-factor                            → TwoFactorPage
  /verify                                → VerifyPage
/(onboarding)
  /new-organization                      → NewOrganizationPage

/account
  /                                      → AccountPage
  /profile                               → ProfilePage
  /preferences                           → PreferencesPage
  /privacy                               → PrivacyPage
  /security                              → SecurityPage

/cli/authorize                           → CLI OAuth loopback
/github/setup                            → GitHub App install
/api/v1/*                                → thin proxy routes into apps/api
/api/auth/[...all]                       → Better Auth handler
/api/command-menu/search|suggestions     → ⌘K search backend
/api/schema/[...path]                    → JSON schema passthrough

/[orgSlug]
  /                                      → org dashboard
  /billing
    /subscription                        → BillingSubscriptionPage
    /usage                                → BillingUsagePage
    /invoices                             → BillingInvoicesPage
  /members
    /pending                              → PendingMembersPage
  /access
    /sessions                             → AccessSessionsPage
    /reviews                              → AccessReviewsPage
  /security
    /mfa                                  → SecurityMfaPage
    /audit                                → SecurityAuditPage
    /compliance                           → SecurityCompliancePage
    /trust                                → SecurityTrustPage
  /developer
    /mcp                                  → DeveloperMcpPage
    /tokens                               → DeveloperTokensPage
  /settings
    /general                              → OrgGeneralSettingsPage
    /members                              → OrgMembersSettingsPage
    /billing                              → OrgBillingSettingsPage
    /privacy                              → OrgPrivacySettingsPage
  /new-workspace                          → NewWorkspacePage

/[orgSlug]/[workspaceSlug]
  /                                      → workspace home (chat)
  /ask                                   → AskPage (one-shot query)
  /chat                                  → ChatPage (conversation)

  /activity
    /                                    → ActivityPage (execution list)
    /[executionId]                       → ExecutionDetailPage (span tree, child-run trace, debug)

  /workbench                             → redirects to /workbench/agents
    /agents                              → WorkbenchAgentsPage + AgentBuilder (new/[agentId])
    /tools                               → Agent Tools hub (All Tools / Skills / MCP Servers / Capabilities)
    /environments                        → WorkbenchEnvironmentsPage (EnvironmentsPanel)
    /sandboxes                           → WorkbenchSandboxesPage (sessions + SandboxTemplatesPanel)

  /marketplace                           → MarketplacePage
    /browse                              → BrowseMarketplacePage (plugin/skill catalog)
    /installed                           → InstalledMarketplacePage
    /mcp                                 → McpMarketplacePage
    /integrations                        → MarketplaceIntegrationsPage
    /agent-tools                         → MarketplaceAgentToolsPage

  /evals                                 → EvalsPage (datasets + runs, LLM-as-judge)
    /runs                                → EvalRunsListPage
    /runs/[runId]                        → EvalRunDetailPage

  /knowledge
    /                                    → KnowledgePage
    /explore                             → GraphExplorerPage (Neo4j viz, reagraph)
    /inference                           → InferenceReviewPage (semantic edge approve/reject)
    /memories                            → MemoriesPage
    /nodes                               → NodesPage
    /repos                               → ReposPage (GitHub connectors)

  /settings
    /general                             → WorkspaceGeneralForm
    /budget                              → BudgetPolicyForm (workspace budget policy)
    /github                              → GithubConnectionSettings
    /knowledge                           → KnowledgeSettingsPage
    /memory                              → MemoryPolicyForm
    /mcp-server-registries               → RegistryManager (registry admin lives ONLY here)
    /models                              → ModelsForm
    /prompts                             → PromptSettingsForm
    /members                             → MembersPage
    (/environments, /plugins, /skills    → redirects into Workbench)
```

### Component Hierarchy
```
apps/app/src/components/
  shell/
    sidebar.tsx, sidebar-item.tsx, sidebar-context.tsx → nav shell (see lib/sidebar.ts)
    ask/                                 → AskShell (one-shot UI)
  chat/
    chat-shell-client.tsx                → main chat UI, StepMarker, streaming
    registry-components/                 → rendered structured tool-output cards
      automation-create-inline-steps.tsx → StepsEditor
      capability-chain-card.tsx          → StepStatus
    structured-value.tsx                 → StructuredValueProps renderer
  agent-panel/                          → agent sidebar panel
  activity/
    span-tree.tsx                        → execution step tree (StepNode)
  knowledge/
    graph/                               → Neo4j graph visualization (reagraph)
    graph-explorer/                      → interactive graph explorer
    memories/                            → memory list/management
    schema-builder/                      → ontology schema UI
    sources/                             → data source connectors
  conversations/                        → conversation list/management
  auth/                                  → login/signup forms
  billing/                               → plan/credits UI
  connectors/                            → integration connector cards
  org/                                   → org management components
  plugins/                               → plugin catalog/management
  security/                              → security events, policy
  settings/                              → shared settings panels
  workspace/                             → workspace switcher, nav
  media/                                 → image/video/asset upload
  loading/                               → skeleton loaders
  pwa/                                   → PWA install/update prompts
  brand/                                 → logo/wordmark assets
  ui/                                    → local overrides of @oxagen/ui
```

### State Management
- **No global store** (Zustand/Jotai not used at app level)
- **Server state**: Next.js Server Actions + RSC data fetching
- **Client state**: React `useState` / `useReducer` per component
- **Mutations**: Server Actions in `*-actions.ts` / `actions.ts` co-located with pages (e.g. `settings/budget/budget-action.ts`)
- **Streaming**: SSE via `chat/stream` endpoint, consumed in `chat-shell-client.tsx`
- **URL state**: `useSearchParams` for filters/tabs

### Key Shared Libs
```
apps/app/src/lib/
  routes.ts           → typed route helpers (org/workspace/account URL builders)
  sidebar.ts           → sidebar nav config + breadcrumb targets (source of truth for page tree)
  actions/             → shared server action utilities
  ask/                 → ask-mode helpers
  command-menu/        → ⌘K search integration
  page-context/        → RSC page context helpers
  tenant/              → org/workspace context resolution
```

### Data Fetching Pattern
```
page.tsx (RSC)
  → direct DB query via @oxagen/database (server-only)
  OR → fetch from /api/* Next.js API routes (thin proxy to apps/api)
  → passes data to Client Components as props
  → mutations via Server Actions (apps/app/src/app/*/actions.ts)
  → revalidatePath / revalidateTag after mutations
```

---

## apps/cli — Terminal Agent (Ink + Commander)

### Entry Points
```
apps/cli/src/index.tsx          → binary entry, Commander setup
apps/cli/src/program.tsx        → CLI program definition
```

### Command Structure
```
oxagen                          → interactive REPL (default)
oxagen "<prompt>"               → one-shot mode (root positional argument;
                                    there is no separate `ask` subcommand —
                                    program.tsx `.argument("[prompt...]")`)
oxagen init                     → project init
oxagen fleet                    → multi-agent fleet view
oxagen trace                    → agent execution span-tree viewer (incl. A2A child runs)
```
`apps/cli/src/commands/` has 35 command modules (count drifts — don't hard-code
it; regenerate via `find apps/cli/src/commands -maxdepth 1 -type f | wc -l`).

### Agent Loop
```
apps/cli/src/agent/
  loop.ts                       → main ReAct loop
  model-router.ts               → model tier selection (fast/balanced/precise)
  model.ts                      → AI SDK call wrapper
  planner.ts                    → task planning
  permissions.ts                → tool permission gates
  system-prompt.ts              → system prompt assembly
  prompt-enhancer.ts            → context injection
  rate-card.ts                  → token/cost tracking
  timeouts.ts                   → per-tool timeout config
  memory.ts                     → project-scoped memory
  code-graph.ts                 → local code graph provider
  project-context.ts            → cwd/git context
  adapters/
    code-graph-provider.ts
    code-map-provider.ts
    memory-provider.ts
    platform-agent-ai.ts        → API gateway adapter
    workspace.ts                → workspace context
  fleet/
    orchestrator.ts             → multi-agent orchestration
    store.ts                    → fleet state (per-project key)
    memory.ts                   → fleet-shared memory
    git-isolation.ts            → per-agent git worktree
    types.ts
```

### TUI Components (Ink)
```
apps/cli/src/tui/
  agent-view/                   → `oxagen view`: audit agent work on real data only
    data.ts                     → honest data layer: sessions/rollup/activity/
                                  code-graph (DuckDB read-only)/daemon/auth (injectable probes)
    index.tsx                   → shell: 3s real-read refresh, q/Esc/^C quit, non-TTY text snapshot
    sessions-panel.tsx          → agent-runs audit table (ADR-023 session logs)
    overview-panel.tsx          → state rollup + real spend (today/all-time)
    activity-panel.tsx          → newest run's real events via toAggregateLine
    code-graph-panel.tsx        → real code-graph stats (absent/locked/empty/ready)
    status-bar.tsx              → real daemon/graph/auth health
  fleet-view/
    fleet-app.tsx                → fleet orchestrator TUI
    agent-row.tsx                → per-agent status row
    dispatch-input.tsx           → task dispatch input
    fleet-summary.tsx            → summary stats
  welcome-screen/                → animated welcome
  banner.tsx
  theme.ts
```

### Settings / Config
```
apps/cli/src/settings/
  schema.ts                     → settings Zod schema (source of @oxagen/schemas JSON schema)
  resolve.ts                    → config file resolution (~/.config/oxagen/)
  runtime.ts                    → runtime overrides
  gate.ts                       → feature gates
  hooks.ts                      → settings change hooks
  permissions-gate.ts           → permission enforcement
  mcp-write.ts                  → MCP server config write
  write.ts                      → config file write
```

### REPL
```
apps/cli/src/repl/
  interactive.tsx               → full interactive REPL (Ink)
  one-shot.ts                   → non-interactive single-turn
  components.tsx                → shared REPL components
  slash-menu.tsx                → /command menu
  escape-action.ts              → Escape key handler
```

### Slash Commands / Rules
```
apps/cli/src/slash/             → /command catalog, loader, expand
apps/cli/src/rules/             → .oxagen rules enforcement
apps/cli/src/mcp/client.ts      → local MCP client
apps/cli/src/config/indexer.ts  → scanConventions/scanSkills project indexing
apps/cli/src/lib/
  api.ts                        → API client (to api.oxagen.sh)
  session.ts                    → session management
  pkce.ts                       → PKCE OAuth flow
  loopback-login.ts             → CLI auth loopback
  memory-client.ts              → memory API client
  workspace-link.ts             → workspace linking
  differential-context.ts       → diff-based context
  structured-tool-io.ts         → tool I/O formatting (isErrorResult; keep aligned
                                    with agent/loop.ts's error-detection logic)
```
